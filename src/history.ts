import * as path from 'path';
import * as vscode from 'vscode';
import { baseName, count, diffLocks, parserFor, stripBom, UNSUPPORTED, type Counts, type ParsedLock } from './core';
import type { GitRepo, LogEntry } from './git';

export const HISTORY_VIEW = 'lockfileDiff.history';
const PAGE = 50;
const NULL_ID = /^0+$/;

/** What one commit did to the lockfile, in a few characters: `+3 −1 ↑12 (2 major)`. */
export function shortSummary(c: Counts): string {
  const parts: string[] = [];
  if (c.added) parts.push(`+${c.added}`);
  if (c.removed) parts.push(`−${c.removed}`);
  if (c.upgraded) parts.push(`↑${c.upgraded}${c.major ? ` (${c.major} major)` : ''}`);
  if (c.downgraded) parts.push(`↓${c.downgraded}`);
  if (c.changed) parts.push(`~${c.changed}`);
  return parts.length ? parts.join(' ') : 'no dependency changes';
}

type Summary = { text: string; counts?: Counts; error?: boolean };

/** The day in local time, as `git log` and the tooltip show it: 2026-10-21. */
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

class CommitItem extends vscode.TreeItem {
  constructor(
    readonly entry: LogEntry,
    summary: Summary | undefined,
    open: vscode.Command,
  ) {
    super(entry.subject || entry.commit.slice(0, 8), vscode.TreeItemCollapsibleState.None);
    const when = localDate(entry.date);
    this.description = `${summary ? summary.text : 'reading…'} · ${entry.commit.slice(0, 7)} · ${when}`;
    const major = summary?.counts?.major ?? 0;
    this.iconPath = new vscode.ThemeIcon(major ? 'warning' : 'git-commit', major ? new vscode.ThemeColor('charts.red') : undefined);
    const md = new vscode.MarkdownString();
    md.appendText(`${entry.subject}\n\n${entry.commit.slice(0, 10)} · ${entry.author} · ${entry.date.toLocaleString()}\n\n${summary ? summary.text : 'Reading the lockfile…'}`);
    this.tooltip = md;
    this.accessibilityInformation = { label: `${entry.subject}, ${summary ? summary.text : 'reading'}, ${entry.author}, ${when}` };
    this.command = open;
    this.contextValue = 'commit';
    this.id = entry.commit;
  }
}

class MoreItem extends vscode.TreeItem {
  constructor(command: vscode.Command) {
    super('Load older commits…', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('history');
    this.command = command;
    this.id = '__more';
  }
}

class InfoItem extends vscode.TreeItem {
  constructor(text: string) {
    super(text, vscode.TreeItemCollapsibleState.None);
    this.id = '__info';
  }
}

type Item = CommitItem | MoreItem | InfoItem;

/**
 * The commits that changed one lockfile, newest first, with what each did to its
 * dependencies. Commits load a page at a time; summaries fill in one by one in the
 * background and stop as soon as the view moves to another file or closes.
 */
export class HistoryProvider implements vscode.TreeDataProvider<Item>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Item | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private repo?: GitRepo;
  private rel?: string;
  private entries: LogEntry[] = [];
  private more = false;
  private loading = false;
  private error?: string;
  /** Bumped by every show() and clear(): results of an older one are dropped. */
  private generation = 0;
  /** The commit the list starts at: HEAD when it was opened. */
  private head?: string;
  /** Commit ids listed: tree item ids must be unique. */
  private readonly seen = new Set<string>();
  private followed?: GitRepo;
  private headSub?: vscode.Disposable;
  private readonly summaries = new Map<string, Summary>();
  /** Parsed lockfiles by blob id: neighbouring commits share one. */
  private readonly parsed = new Map<string, ParsedLock | undefined>();
  private cancel?: vscode.CancellationTokenSource;
  private fire?: ReturnType<typeof setTimeout>;
  view?: vscode.TreeView<Item>;

  constructor(private readonly openCommand: string) {}

  /** The file shown, for the view's description: `web/package-lock.json`. */
  get label(): string | undefined {
    return this.rel?.split(path.sep).join('/');
  }

  async show(repo: GitRepo, rel: string) {
    // A new generation: whatever an older show() or page is still waiting for is dropped.
    const gen = ++this.generation;
    this.cancel?.cancel();
    this.follow(repo);
    this.repo = repo;
    this.rel = rel;
    this.reset();
    this.loading = true;
    this.changed.fire();
    // go.sum lists every version ever consulted; go.mod is what changed.
    if (baseName(rel) === 'go.sum') {
      const mod = rel.slice(0, -'go.sum'.length) + 'go.mod';
      const hasMod = (await repo.read({ kind: 'commit', ref: 'HEAD' }, mod)) !== undefined;
      if (gen !== this.generation) return;
      if (hasMod) this.rel = mod;
    }
    if (this.view) {
      this.view.description = this.label;
      this.view.message = undefined;
    }
    // Pages after the first go on from the commit the first one started at, not from
    // wherever HEAD is by then.
    let head: string | undefined;
    try {
      head = await repo.resolve('HEAD');
    } catch {
      head = undefined; // no commits yet
    }
    if (gen !== this.generation) return;
    this.head = head;
    await this.load(gen);
  }

  private reset() {
    this.entries = [];
    this.seen.clear();
    this.summaries.clear();
    this.parsed.clear();
    this.more = false;
    this.loading = false;
    this.error = undefined;
    this.head = undefined;
  }

  /** Reloads the list when HEAD moves (a commit, a pull, a checkout): its pages would no longer line up. */
  private follow(repo: GitRepo) {
    if (this.followed === repo) return;
    this.headSub?.dispose();
    this.followed = repo;
    this.headSub = repo.onDidChange?.(() => {
      const now = repo.api?.state.HEAD?.commit;
      if (this.repo === repo && this.rel && this.head && now && now !== this.head) void this.show(repo, this.rel);
    });
  }

  clear() {
    this.generation++;
    this.cancel?.cancel();
    this.headSub?.dispose();
    this.headSub = this.followed = undefined;
    this.repo = undefined;
    this.rel = undefined;
    this.reset();
    this.changed.fire();
  }

  async loadMore() {
    if (this.loading) return;
    await this.load(this.generation);
  }

  private async load(gen: number) {
    const repo = this.repo;
    const rel = this.rel;
    if (!repo || !rel) return;
    if (!this.head) {
      this.loading = false;
      this.changed.fire();
      return;
    }
    this.loading = true;
    this.changed.fire();
    let page: LogEntry[] | undefined;
    try {
      page = await repo.lockfileLog(rel, this.head, this.entries.length, PAGE + 1);
    } catch (e) {
      if (gen === this.generation) this.error = e instanceof Error ? e.message : String(e);
    }
    // Another file (or a reload) since: its own load is under way.
    if (gen !== this.generation) return;
    this.loading = false;
    if (page) {
      this.more = page.length > PAGE;
      for (const e of page.slice(0, PAGE)) {
        if (this.seen.has(e.commit)) continue;
        this.seen.add(e.commit);
        this.entries.push(e);
      }
    }
    this.changed.fire();
    void this.summarize();
  }

  /** Fills in the summaries not computed yet, newest first, until cancelled. */
  private async summarize() {
    this.cancel?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.cancel = cts;
    const repo = this.repo!;
    const rel = this.rel!;
    for (const e of [...this.entries]) {
      if (cts.token.isCancellationRequested) return;
      if (this.summaries.has(e.commit)) continue;
      let s: Summary;
      try {
        const parser = parserFor(rel);
        if (!parser) throw new Error(UNSUPPORTED[baseName(rel)] ?? `${baseName(rel)} is not a lockfile this extension can read.`);
        const [a, b] = await Promise.all([this.parse(repo, rel, e.before), this.parse(repo, rel, e.after)]);
        const { changes } = diffLocks(a, b, parser.ecosystem);
        const counts = count(changes);
        s = { text: !a && b ? `created · ${shortSummary(counts)}` : a && !b ? 'deleted' : shortSummary(counts), counts };
      } catch (err) {
        s = { text: `couldn't be read: ${err instanceof Error ? err.message : String(err)}`, error: true };
      }
      if (cts.token.isCancellationRequested) return;
      this.summaries.set(e.commit, s);
      this.schedule();
      // Keep the extension host responsive between big lockfiles.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  private async parse(repo: GitRepo, rel: string, id: string): Promise<ParsedLock | undefined> {
    if (NULL_ID.test(id)) return undefined;
    if (this.parsed.has(id)) return this.parsed.get(id);
    const parser = parserFor(rel);
    if (!parser) return undefined;
    const lock = parser.parse(stripBom(await repo.blob(id)), { fileName: baseName(rel), siblings: {} });
    // Two are enough: each commit's "after" is the next older commit's "before".
    if (this.parsed.size >= 4) this.parsed.delete(this.parsed.keys().next().value!);
    this.parsed.set(id, lock);
    return lock;
  }

  private schedule() {
    if (this.fire) return;
    this.fire = setTimeout(() => {
      this.fire = undefined;
      this.changed.fire();
    }, 120);
  }

  getTreeItem(item: Item): vscode.TreeItem {
    return item;
  }

  getChildren(item?: Item): Item[] {
    if (item) return [];
    if (!this.rel) return [];
    if (this.error) return [new InfoItem(this.error)];
    if (!this.entries.length) return [new InfoItem(this.loading ? 'Reading history…' : 'No commits on this branch changed this lockfile.')];
    const items: Item[] = this.entries.map(
      (e) => new CommitItem(e, this.summaries.get(e.commit), { command: this.openCommand, title: 'Show Dependency Changes', arguments: [this.repo!.root, this.rel, e.commit, e.parent ?? null] }),
    );
    if (this.more) items.push(new MoreItem({ command: 'lockfileDiff.historyMore', title: 'Load older commits' }));
    return items;
  }

  dispose() {
    this.cancel?.cancel();
    this.headSub?.dispose();
    this.changed.dispose();
    if (this.fire) clearTimeout(this.fire);
  }
}
