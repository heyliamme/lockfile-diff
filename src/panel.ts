import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { baseName, findEntry, isLockfile, isRegistryUrl, type FileDiff } from './core';
import { canMergeBase, isLive, readConfig, run, type Part, type Request } from './comparison';
import { findRepo, type Rev } from './git';
import type { FileRef, Filter, FromWebview, ToWebview, ViewData, ViewOptions } from './protocol';

export const VIEW_TYPE = 'lockfileDiff';
const CONTENT_SCHEME = 'lockfile-diff';

/** Read-only documents for revisions, for "Open text diff" and "Go to entry". */
export function registerContentProvider(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(CONTENT_SCHEME, {
    async provideTextDocumentContent(uri) {
      const q = revisionQuery(uri.query);
      if (!q) return '';
      const repo = await findRepo(vscode.Uri.file(q.root));
      return (await repo.read(q.rev, q.rel)) ?? '';
    },
  });
}

/**
 * The query of a `lockfile-diff:` URI, checked: anything can open one of these URIs, and its
 * ref ends up as a Git argument. A ref that reads as an option or a path out of the
 * repository is refused.
 */
export function revisionQuery(query: string): { root: string; rel: string; rev: Rev } | undefined {
  let q: unknown;
  try {
    q = JSON.parse(query);
  } catch {
    return undefined;
  }
  if (!q || typeof q !== 'object') return undefined;
  const { root, rel, rev } = q as { root?: unknown; rel?: unknown; rev?: { kind?: unknown; ref?: unknown } };
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return undefined;
  if (rel.split(/[\\/]/).includes('..')) return undefined;
  if (!rev || typeof rev !== 'object') return undefined;
  if (rev.kind === 'worktree' || rev.kind === 'index') return { root, rel, rev: { kind: rev.kind } };
  if (rev.kind === 'commit' && typeof rev.ref === 'string' && rev.ref && !rev.ref.startsWith('-')) return { root, rel, rev: { kind: 'commit', ref: rev.ref } };
  return undefined;
}

/**
 * A URI VS Code can open for a file at a revision. VS Code keeps a document per URI, so
 * the URI carries what HEAD or the index points at now (`id`): after a commit or a stage
 * it is a new document instead of the stale one.
 */
async function revisionUri(root: string, rel: string, rev: Rev): Promise<vscode.Uri> {
  const abs = path.join(root, rel);
  if (rev.kind === 'worktree') return vscode.Uri.file(abs);
  let id = '';
  try {
    id = await (await findRepo(vscode.Uri.file(root))).contentId(rev, rel);
  } catch {
    // shown as it reads; the provider reports what it can
  }
  return vscode.Uri.file(abs).with({ scheme: CONTENT_SCHEME, query: JSON.stringify({ root, rel, rev, id }) });
}

/** Whether `file` is inside `root`, compared as the platform does (case-insensitively on Windows). */
function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Files whose unsaved edits change a comparison: lockfiles and the manifests read next to them. */
const MANIFESTS = /(^|[\\/])(package\.json|composer\.json|pyproject\.toml|go\.mod|pubspec\.yaml|Cargo\.toml|Gemfile|gems\.rb)$/;

export function readOptions(): ViewOptions {
  const c = vscode.workspace.getConfiguration('lockfileDiff');
  const f = c.get<unknown>('defaultFilter');
  const filters: Filter[] = ['all', 'major', 'upgraded', 'added', 'removed'];
  return { filter: filters.includes(f as Filter) ? (f as Filter) : 'all', directOnly: c.get<unknown>('directOnly') === true };
}

interface Saved {
  request: Request;
  options?: ViewOptions;
}

export class LockfilePanel {
  private static open = new Map<string, LockfilePanel>();
  private disposables: vscode.Disposable[] = [];
  private watchers: vscode.Disposable[] = [];
  private files: FileDiff[] = [];
  private options: ViewOptions;
  private pending?: ReturnType<typeof setTimeout>;
  private running = 0;
  /** A run is in flight; another trigger meanwhile asks for one more after it (`again`). */
  private inFlight = false;
  private again = false;
  /** Something changed while the panel was hidden: refresh when it shows again. */
  private stale = false;
  /** Roots whose Git state this panel follows, with what HEAD and the index were last seen as. */
  private readonly repoKeys = new Map<string, string>();
  private readonly following = new Set<string>();
  private ready = false;
  private disposed = false;
  /** True when the last run started at a merge base (the sides' histories diverged). */
  private fromBase = false;
  private queued?: ToWebview;
  /** The last data or error sent, for a view whose document reloads and asks again. */
  private last?: ToWebview;

  /** Opens a comparison, or brings back the one already showing the same thing. */
  static show(extensionUri: vscode.Uri, request: Request): LockfilePanel {
    const key = JSON.stringify(request);
    const existing = LockfilePanel.open.get(key);
    if (existing) {
      existing.panel.reveal();
      existing.refresh();
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Lockfile Diff', vscode.ViewColumn.Active, LockfilePanel.webviewOptions(extensionUri));
    return new LockfilePanel(extensionUri, panel, request);
  }

  /** The tab Lockfile History opens commits in: one tab, reused from one commit to the next. */
  private static history?: LockfilePanel;

  /** A commit from Lockfile History: in the history tab, as the Timeline's preview does. */
  static showHistory(extensionUri: vscode.Uri, request: Request): LockfilePanel {
    const existing = LockfilePanel.open.get(JSON.stringify(request));
    const reuse = LockfilePanel.history;
    if (existing) {
      existing.panel.reveal(undefined, true);
      return existing;
    }
    if (reuse && !reuse.disposed) {
      reuse.replace(request);
      reuse.panel.reveal(undefined, true);
      return reuse;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Lockfile Diff', { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, LockfilePanel.webviewOptions(extensionUri));
    return (LockfilePanel.history = new LockfilePanel(extensionUri, panel, request));
  }

  /** Every open comparison: settings changed, or the workspace was trusted. */
  static refreshAll(trusted = false) {
    for (const p of LockfilePanel.open.values()) {
      if (trusted) p.followRepos();
      p.scheduleRefresh();
    }
  }

  static revive(extensionUri: vscode.Uri, panel: vscode.WebviewPanel, state: unknown) {
    const saved = state as Saved | undefined;
    if (!saved?.request?.parts) {
      panel.dispose();
      return;
    }
    panel.webview.options = LockfilePanel.webviewOptions(extensionUri);
    return new LockfilePanel(extensionUri, panel, saved.request, saved.options);
  }

  private static webviewOptions(extensionUri: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')] };
  }

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly panel: vscode.WebviewPanel,
    private request: Request,
    options?: ViewOptions,
  ) {
    this.options = options ?? readOptions();
    LockfilePanel.open.set(JSON.stringify(request), this);
    panel.title = this.title();
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m), null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.onDidChangeViewState((e) => e.webviewPanel.visible && this.stale && this.scheduleRefresh(), null, this.disposables);
    this.watch();
    this.refresh();
  }

  private title(): string {
    const { parts, left, right } = this.request;
    const one = parts.length === 1 && (parts[0].kind === 'uris' || parts[0].files?.length === 1);
    const name = !one ? 'Dependencies' : parts[0].kind === 'uris' ? baseName(vscode.Uri.parse(parts[0].right).path) : baseName(parts[0].files![0]);
    // Git's own notation, `main...feature`, once the comparison really starts at a merge base.
    return `${name} (${left}${this.fromBase ? '...' : ' ↔ '}${right})`;
  }

  private post(m: ToWebview) {
    if (this.disposed) return;
    if (m.type !== 'loading') this.last = m;
    if (!this.ready) {
      // The view asks for data once its script runs; until then keep only the latest message.
      if (m.type !== 'loading') this.queued = m;
      return;
    }
    void this.panel.webview.postMessage(m);
  }

  /**
   * Re-reads both sides and recomputes. One run at a time: a trigger during a run asks for
   * one more after it, however many arrive.
   */
  async refresh() {
    if (this.disposed) return;
    if (this.inFlight) {
      this.again = true;
      return;
    }
    this.inFlight = true;
    this.stale = false;
    try {
      await this.runOnce();
    } finally {
      this.inFlight = false;
    }
    if (this.again && !this.disposed) {
      this.again = false;
      this.scheduleRefresh();
    }
  }

  private async runOnce() {
    const id = ++this.running;
    const started = Date.now();
    this.post({ type: 'loading', title: this.title(), left: this.request.left, right: this.request.right });
    try {
      const { files, hidden, base } = await run(this.request);
      if (id !== this.running || this.disposed) return;
      this.files = files;
      this.fromBase = !!base?.mergeBase && this.request.parts.some((p) => p.kind === 'repo' && p.mergeBase);
      this.panel.title = this.title();
      const { left, right } = this.request;
      const notices: string[] = [];
      if (hidden.length) {
        const root = this.request.parts.find((p) => p.kind === 'repo')?.root;
        const where = readConfig(root ? vscode.Uri.file(root) : undefined).fromWorkspace ? "this workspace's settings" : 'your settings';
        const list = hidden.length <= 5 ? `: ${hidden.join(', ')}` : '';
        notices.push(`${hidden.length} changed ${hidden.length === 1 ? 'lockfile is' : 'lockfiles are'} hidden by lockfileDiff.exclude (set in ${where})${list}.`);
      }
      const data: ViewData = {
        title: files.length === 1 ? files[0].path : files.length ? `${files.length} lockfiles` : 'No lockfiles changed',
        left,
        right,
        files,
        live: isLive(this.request),
        took: Date.now() - started,
        message: files.length ? undefined : hidden.length ? `No lockfiles to show between ${left} and ${right}: every changed one is excluded.` : `No lockfiles changed between ${left} and ${right}.`,
        notices,
        base: base && {
          mode: this.request.parts.some((p) => p.kind === 'repo' && p.mergeBase) ? 'mergeBase' : 'tips',
          mergeBase: base.mergeBase,
          diverged: base.diverged,
          unrelated: base.unrelated,
        },
      };
      this.post({ type: 'data', data, options: this.options, request: this.request });
    } catch (e) {
      if (id === this.running) this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  /** A refresh soon, or when the panel shows again: a hidden panel doesn't recompute. */
  private scheduleRefresh() {
    if (this.disposed) return;
    if (!this.panel.visible) {
      this.stale = true;
      return;
    }
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => void this.refresh(), 400);
  }

  /**
   * Follows HEAD, the index and the named refs of each repository of a live comparison. Git
   * reports a status run after any file save or window focus: only a moved HEAD or ref, or a
   * changed index, refreshes (working tree files have the file watchers). Retried once the workspace is trusted.
   */
  private followRepos() {
    if (!isLive(this.request)) return;
    for (const p of this.request.parts) {
      if (p.kind !== 'repo' || this.following.has(p.root)) continue;
      this.following.add(p.root);
      void findRepo(vscode.Uri.file(p.root))
        .then(async (repo) => {
          if (!repo.onDidChange || this.disposed) return;
          // HEAD, the index, and the branches the comparison names (a fetch moves origin/main).
          const stateKey = async () => {
            const refs = new Set<string>();
            for (const q of this.request.parts) if (q.kind === 'repo' && q.root === p.root) for (const r of [q.left, q.right]) if (r.kind === 'commit' && !/^[0-9a-f]{40}$/i.test(r.ref)) refs.add(r.ref);
            const ids = await Promise.all([...refs].map((r) => repo.resolve(r).catch(() => '')));
            return [await repo.stateKey(), ...ids].join('|');
          };
          this.repoKeys.set(p.root, await stateKey());
          const sub = repo.onDidChange(async () => {
            const key = await stateKey();
            if (key === this.repoKeys.get(p.root)) return;
            this.repoKeys.set(p.root, key);
            this.scheduleRefresh();
          });
          // The panel may have closed while Git was still starting.
          if (this.disposed) sub.dispose();
          else this.watchers.push(sub);
        })
        // Restricted Mode, or Git not ready: tried again when the workspace is trusted.
        .catch(() => this.following.delete(p.root));
    }
  }

  /** Follows the working tree and the index when either is a side. */
  private watch() {
    if (!isLive(this.request)) return;
    const names = new Set<string>();
    for (const p of this.request.parts) {
      if (p.kind === 'uris') {
        for (const u of [p.left, p.right].map((s) => vscode.Uri.parse(s))) {
          if (u.scheme !== 'file') continue;
          const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(u, '..'), baseName(u.path)));
          this.watchers.push(w, w.onDidChange(() => this.scheduleRefresh()), w.onDidCreate(() => this.scheduleRefresh()), w.onDidDelete(() => this.scheduleRefresh()));
        }
        continue;
      }
      names.add(p.root);
    }
    this.followRepos();
    for (const root of names) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**/{package-lock.json,npm-shrinkwrap.json,yarn.lock,pnpm-lock.yaml,bun.lock,pubspec.lock,poetry.lock,uv.lock,Cargo.lock,go.sum,go.mod,composer.lock,Gemfile.lock,gems.locked,package.json,composer.json,pyproject.toml,pubspec.yaml,Cargo.toml,Gemfile,gems.rb}'));
      this.watchers.push(w, w.onDidChange(() => this.scheduleRefresh()), w.onDidCreate(() => this.scheduleRefresh()), w.onDidDelete(() => this.scheduleRefresh()));
    }
    // Unsaved edits to a lockfile on the working tree side.
    this.watchers.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme === 'file' && e.contentChanges.length && this.touches(e.document.uri)) this.scheduleRefresh();
      }),
    );
  }

  private touches(uri: vscode.Uri): boolean {
    return this.request.parts.some((p) =>
      p.kind === 'uris' ? p.left === uri.toString() || p.right === uri.toString() : inside(p.root, uri.fsPath) && (isLockfile(uri.path) || MANIFESTS.test(uri.path)),
    );
  }

  private async onMessage(m: FromWebview) {
    switch (m.type) {
      case 'ready':
        // Also after the view's document reloads (Reload Webviews, a move to another window):
        // send what it showed again.
        this.ready = true;
        this.queued = undefined;
        if (this.last) void this.panel.webview.postMessage(this.last);
        return;
      case 'refresh':
        return this.refresh();
      case 'open':
        // Only links the extension built itself: https on a known registry.
        if (isRegistryUrl(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url, true));
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        vscode.window.setStatusBarMessage(`Lockfile Diff: copied ${m.what}`, 3000);
        return;
      case 'state':
        this.options = m.options;
        return;
      case 'textDiff':
        return this.textDiff(m.file);
      case 'setBase':
        return this.setBase(m.mergeBase);
      case 'reveal':
        return this.reveal(m.file, m.name, m.version, m.side);
    }
  }

  /** Switches between "since the merge base" and "tip to tip": a different comparison in the same tab. */
  private setBase(mergeBase: boolean) {
    const parts = this.request.parts.map((p) => (canMergeBase(p) && p.kind === 'repo' ? { ...p, mergeBase } : p));
    const next: Request = { ...this.request, parts };
    const key = JSON.stringify(next);
    if (LockfilePanel.open.has(key)) {
      LockfilePanel.open.get(key)!.panel.reveal();
      return;
    }
    this.replace(next);
  }

  /** Shows another comparison in this tab. */
  private replace(next: Request) {
    LockfilePanel.open.delete(JSON.stringify(this.request));
    this.request = next;
    LockfilePanel.open.set(JSON.stringify(next), this);
    this.fromBase = false;
    this.panel.title = this.title();
    void this.refresh();
  }

  /** The part of the request a file of the view came from, and its path in that part. */
  private locate(file: FileRef): { part: Part; rel: string } | undefined {
    const o = file.origin;
    const part = o && Number.isInteger(o.part) ? this.request.parts[o.part] : undefined;
    if (!part || typeof o?.rel !== 'string' || path.isAbsolute(o.rel) || o.rel.split(/[\\/]/).includes('..')) return undefined;
    return { part, rel: o.rel };
  }

  private async sideUris(file: FileRef): Promise<[vscode.Uri, vscode.Uri] | undefined> {
    const at = this.locate(file);
    if (!at) return undefined;
    if (at.part.kind === 'uris') return [vscode.Uri.parse(at.part.left), vscode.Uri.parse(at.part.right)];
    const { root, right } = at.part;
    // The merge base comes back from the view: only a commit id is taken.
    const base = file.origin?.base;
    const left: Rev = typeof base === 'string' && /^[0-9a-f]{7,64}$/.test(base) ? { kind: 'commit', ref: base } : at.part.left;
    return Promise.all([revisionUri(root, at.rel, left), revisionUri(root, at.rel, right)]);
  }

  private async textDiff(file: FileRef) {
    const uris = await this.sideUris(file);
    if (!uris) return;
    const name = baseName(file.path);
    await vscode.commands.executeCommand('vscode.diff', uris[0], uris[1], `${name} (${this.request.left} ↔ ${this.request.right})`, { preview: true });
  }

  /** Opens the lockfile on one side at the entry for a package. */
  private async reveal(file: FileRef, name: string, version: string | undefined, side: 'left' | 'right') {
    const shown = file.path;
    const uris = await this.sideUris(file);
    if (!uris) return;
    const uri = uris[side === 'left' ? 0 : 1];
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const line = findEntry(doc.getText(), name, version);
      const range = new vscode.Range(line, 0, line, 0);
      await vscode.window.showTextDocument(doc, { selection: range, viewColumn: vscode.ViewColumn.Beside, preview: true });
    } catch (e) {
      void vscode.window.showWarningMessage(`Lockfile Diff: couldn't open ${baseName(shown)} (${e instanceof Error ? e.message : String(e)}).`);
    }
  }

  private html() {
    const w = this.panel.webview;
    const nonce = randomBytes(16).toString('hex');
    const asset = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', f));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}'; font-src ${w.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('codicon.css')}">
<link rel="stylesheet" href="${asset('webview.css')}">
<title>Lockfile Diff</title>
</head>
<body>
<div id="app" data-state="${encodeURIComponent(JSON.stringify({ request: this.request }))}"></div>
<script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
  }

  private dispose() {
    this.disposed = true;
    LockfilePanel.open.delete(JSON.stringify(this.request));
    if (this.pending) clearTimeout(this.pending);
    for (const d of [...this.disposables, ...this.watchers]) d.dispose();
  }
}
