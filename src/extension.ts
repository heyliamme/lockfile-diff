import * as path from 'path';
import * as vscode from 'vscode';
import { baseName, isLockfile, UNSUPPORTED } from './core';
import { revLabel, type Part, type Request } from './comparison';
import { findRepo, GitError, workspaceRepos, type GitRepo, type Rev } from './git';
import { HISTORY_VIEW, HistoryProvider } from './history';
import { LockfilePanel, registerContentProvider, VIEW_TYPE } from './panel';

/** `git:` URIs carry the revision in their query: `{"path": …, "ref": "HEAD"}`; `""` or `~` is the index. */
function gitRev(uri: vscode.Uri): Rev | undefined {
  if (uri.scheme === 'file') return { kind: 'worktree' };
  if (uri.scheme !== 'git') return undefined;
  try {
    const ref = (JSON.parse(uri.query || '{}') as { ref?: string }).ref;
    if (ref === undefined) return undefined;
    return ref === '' || ref === '~' ? { kind: 'index' } : { kind: 'commit', ref };
  } catch {
    return undefined;
  }
}

/** Resource groups of the Git extension: 0 merge, 1 index (staged), 2 working tree, 3 untracked. */
interface ResourceState {
  resourceUri: vscode.Uri;
  resourceGroupType?: number;
}
const isResourceState = (x: unknown): x is ResourceState => !!x && typeof x === 'object' && (x as ResourceState).resourceUri instanceof vscode.Uri;
const isSourceControl = (x: unknown): x is { rootUri?: vscode.Uri } => !!x && typeof x === 'object' && 'rootUri' in x && !(x instanceof vscode.Uri);

/** What VS Code passes after the resource for a command run from an editor tab's context menu. */
interface EditorContext {
  groupId: number;
  editorIndex: number;
}
const isEditorContext = (x: unknown): x is EditorContext => !!x && typeof x === 'object' && typeof (x as EditorContext).groupId === 'number' && typeof (x as EditorContext).editorIndex === 'number';

const HEAD: Rev = { kind: 'commit', ref: 'HEAD' };
const WORKTREE: Rev = { kind: 'worktree' };

export function activate(context: vscode.ExtensionContext) {
  const open = (req: Request) => LockfilePanel.show(context.extensionUri, req);
  const command = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        await fn(...args);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        void vscode.window.showErrorMessage(e instanceof GitError ? msg : `Lockfile Diff: ${msg}`);
      }
    });

  const fromMergeBase = () => vscode.workspace.getConfiguration('lockfileDiff').get<unknown>('fromMergeBase') !== false;
  const repoPart = (repo: GitRepo, file: vscode.Uri | undefined, left: Rev, right: Rev, mergeBase?: boolean): Part => ({
    kind: 'repo',
    root: repo.root,
    files: file ? [path.relative(repo.root, file.fsPath)] : undefined,
    left,
    right,
    ...(mergeBase && left.kind === 'commit' ? { mergeBase: true } : {}),
  });
  /** `main...feature` for a comparison from the merge base, as Git writes it. */
  const branchRequest = (repo: GitRepo, file: vscode.Uri | undefined, from: Rev, to: Rev): Request => {
    const mb = fromMergeBase() && from.kind === 'commit';
    return { parts: [repoPart(repo, file, from, to, mb)], left: revLabel(from), right: revLabel(to) };
  };

  const history = new HistoryProvider('lockfileDiff.openHistoryCommit');
  const historyView = vscode.window.createTreeView(HISTORY_VIEW, { treeDataProvider: history, showCollapseAll: false });
  history.view = historyView;

  /** The lockfile a command applies to: its argument, else the active editor's file. */
  const targetFile = (arg: unknown): vscode.Uri | undefined => {
    if (isResourceState(arg)) return arg.resourceUri;
    if (arg instanceof vscode.Uri) return arg;
    if (isSourceControl(arg)) return undefined;
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri && isLockfile(uri.path) ? uri : undefined;
  };

  /**
   * The lockfile on disk a Git command applies to. A `git:` revision of it (a Source Control
   * diff side, a Timeline entry) stands for the file it is a revision of; another scheme for none.
   */
  const diskFile = (arg: unknown): vscode.Uri | undefined => {
    const uri = targetFile(arg);
    if (!uri || uri.scheme === 'file') return uri;
    return uri.scheme === 'git' ? uri.with({ scheme: 'file', query: '' }) : undefined;
  };

  /** The repository for a command run without a file: the SCM provider's, the only one, or a pick. */
  const pickRepo = async (arg: unknown): Promise<GitRepo | undefined> => {
    if (isSourceControl(arg) && arg.rootUri) return findRepo(arg.rootUri);
    const repos = await workspaceRepos();
    if (!repos.length) throw new GitError('No Git repository is open in this window.');
    if (repos.length === 1) return repos[0];
    const pick = await vscode.window.showQuickPick(
      repos.map((r) => ({ label: path.basename(r.root), description: r.root, repo: r })),
      { placeHolder: 'Which repository?' },
    );
    return pick?.repo;
  };

  /**
   * The two sides of a diff editor tab showing `file` (or any lockfile when no file is
   * given). From a tab's context menu, only the tab that was right-clicked: a plain file tab
   * there is not a diff, whatever else is open. Otherwise the active tab, else, for a `git:`
   * revision, the tab that shows it.
   */
  const fromDiffEditor = (file?: vscode.Uri, editor?: EditorContext): Request | undefined => {
    const active = vscode.window.tabGroups.activeTabGroup.activeTab;
    const shows = (t: vscode.Tab | undefined) =>
      t?.input instanceof vscode.TabInputTextDiff && (!file || t.input.modified.toString() === file.toString() || t.input.original.toString() === file.toString());
    const groups = vscode.window.tabGroups.all;
    const anyShowing = () => groups.map((g) => g.activeTab).find(shows) ?? groups.flatMap((g) => g.tabs).find(shows);
    let tab: vscode.Tab | undefined;
    if (editor && file) {
      // The API has no group ids: the tab at that index that shows the file, in the active group first.
      const opens = (t: vscode.Tab | undefined) => shows(t) || (t?.input instanceof vscode.TabInputText && t.input.uri.toString() === file.toString());
      const hits = groups.map((g) => g.tabs[editor.editorIndex]).filter(opens);
      tab = hits.find((t) => t.group === vscode.window.tabGroups.activeTabGroup) ?? hits[0];
      // A git: revision exists only in a diff: if the index didn't lead to it, any tab showing it.
      if (!tab && file.scheme === 'git') tab = anyShowing();
    } else if (shows(active)) tab = active;
    else if (file?.scheme === 'git') tab = anyShowing();
    const input = tab?.input;
    if (!(input instanceof vscode.TabInputTextDiff)) return undefined;
    if (file && input.modified.toString() !== file.toString() && input.original.toString() !== file.toString()) return undefined;
    if (!isLockfile(input.modified.path) && !isLockfile(input.original.path)) return undefined;
    const l = gitRev(input.original);
    const r = gitRev(input.modified);
    const sameFile = input.original.path === input.modified.path;
    // A Source Control diff (git: revisions of one file): read through Git, with manifests at the same revision.
    if (l && r && sameFile && vscode.workspace.isTrusted && (input.original.scheme === 'git' || input.modified.scheme === 'git')) {
      // Root unknown yet: resolveRoots() finds the repository and makes the path relative.
      const abs = input.modified.with({ scheme: 'file', query: '' }).fsPath;
      return { parts: [{ kind: 'repo', root: '', files: [abs], left: l, right: r }], left: revLabel(l), right: revLabel(r) };
    }
    // Anything else (Compare with Saved, two files, another extension's diff): the documents as they are.
    const shown = tab!.label.split(' ↔ ');
    const name = (u: vscode.Uri) => baseName(u.path);
    let left = name(input.original);
    let right = name(input.modified);
    if (left === right) [left, right] = shown.length === 2 && shown[0] !== shown[1] ? [shown[0], shown[1]] : [`${left} (original)`, right];
    return { parts: [{ kind: 'uris', left: input.original.toString(), right: input.modified.toString() }], left, right };
  };

  /** Turns a request with an absolute file and no root (from a diff editor) into one Git can run. */
  const resolveRoots = async (req: Request): Promise<Request> => {
    const parts: Part[] = [];
    for (const p of req.parts) {
      if (p.kind === 'repo' && !p.root && p.files?.length === 1) {
        const abs = vscode.Uri.file(p.files[0]);
        const repo = await findRepo(abs);
        parts.push(repoPart(repo, abs, p.left, p.right));
      } else parts.push(p);
    }
    return { ...req, parts };
  };

  /** Source Control: staged changes are HEAD -> Index, the rest Index -> Working Tree, as their diffs show. */
  const sidesOf = (s?: ResourceState): [Rev, Rev] =>
    s?.resourceGroupType === 1 ? [HEAD, { kind: 'index' }] : s?.resourceGroupType === 2 ? [{ kind: 'index' }, WORKTREE] : [HEAD, WORKTREE];

  /** Several Source Control files: one view per repository and kind of change, with all of its lockfiles. */
  const openResourceStates = async (states: ResourceState[]) => {
    const groups = new Map<string, { repo: GitRepo; sides: [Rev, Rev]; files: string[] }>();
    for (const s of states) {
      const uri = s.resourceUri;
      if (uri.scheme !== 'file' || !isLockfile(uri.path)) continue;
      const repo = await findRepo(uri);
      const sides = sidesOf(s);
      const key = `${repo.root}\0${s.resourceGroupType ?? ''}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { repo, sides, files: [] }));
      g.files.push(path.relative(repo.root, uri.fsPath));
    }
    if (!groups.size) {
      void vscode.window.showInformationMessage('None of the selected files is a lockfile Lockfile Diff reads.');
      return;
    }
    for (const { repo, sides, files } of groups.values()) {
      open({ parts: [{ kind: 'repo', root: repo.root, files, left: sides[0], right: sides[1] }], left: revLabel(sides[0]), right: revLabel(sides[1]) });
    }
  };

  context.subscriptions.push(
    registerContentProvider(),
    // Open comparisons follow what they depend on: the exclude setting, and trust (Git runs only then).
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('lockfileDiff.exclude') && LockfilePanel.refreshAll()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => LockfilePanel.refreshAll(true)),

    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state) => {
        LockfilePanel.revive(context.extensionUri, panel, state);
      },
    }),

    command('lockfileDiff.showChanges', async (arg?: unknown, ...rest: unknown[]) => {
      // Several files selected in Source Control: each comes as an argument of its own.
      const states = [arg, ...rest].filter(isResourceState);
      if (states.length > 1) return openResourceStates(states);
      // From a diff editor: exactly what it shows.
      const file = targetFile(arg);
      const diff = isResourceState(arg) ? undefined : fromDiffEditor(file, isEditorContext(rest[0]) ? rest[0] : undefined);
      if (diff) return open(await resolveRoots(diff));

      if (!file) {
        // Nothing to go on: every changed lockfile of the repository.
        const repo = await pickRepo(arg);
        if (repo) open({ parts: [repoPart(repo, undefined, HEAD, WORKTREE)], left: 'HEAD', right: 'Working Tree' });
        return;
      }
      if (!isLockfile(file.path)) {
        void vscode.window.showInformationMessage(`${baseName(file.path)} is not a lockfile Lockfile Diff reads.`);
        return;
      }
      if (file.scheme !== 'file') {
        void vscode.window.showInformationMessage('Open the lockfile from the working tree, or a diff editor, to see its dependency changes.');
        return;
      }
      const repo = await findRepo(file);
      const [left, right] = sidesOf(isResourceState(arg) ? arg : undefined);
      open({ parts: [repoPart(repo, file, left, right)], left: revLabel(left), right: revLabel(right) });
    }),

    command('lockfileDiff.showAllChanges', async (arg?: unknown) => {
      const repos = isSourceControl(arg) && arg.rootUri ? [await findRepo(arg.rootUri)] : await workspaceRepos();
      if (!repos.length) throw new GitError('No Git repository is open in this window.');
      const parts = repos.map((r) => repoPart(r, undefined, HEAD, WORKTREE));
      open({ parts, left: 'HEAD', right: 'Working Tree' });
    }),

    command('lockfileDiff.compareWithRef', async (arg?: unknown) => {
      const file = diskFile(arg);
      if (file && !isLockfile(file.path)) {
        void vscode.window.showInformationMessage(`${baseName(file.path)} is not a lockfile Lockfile Diff reads.`);
        return;
      }
      const repo = file ? await findRepo(file) : await pickRepo(arg);
      if (!repo) return;
      const what = file ? baseName(file.path) : 'every lockfile';
      const ref = await pickRef(repo, `Compare ${what} in the working tree with…`);
      if (!ref) return;
      open(branchRequest(repo, file, ref, WORKTREE));
    }),

    command('lockfileDiff.compareRefs', async (arg?: unknown) => {
      const file = diskFile(arg);
      const repo = file ? await findRepo(file) : await pickRepo(arg);
      if (!repo) return;
      const what = file ? baseName(file.path) : 'lockfiles';
      const from = await pickRef(repo, `Compare ${what}: pick the base (older side)`);
      if (!from) return;
      const to = await pickRef(repo, `Compare ${what} in ${revLabel(from)} with…`, true);
      if (!to) return;
      open(branchRequest(repo, file, from, to));
    }),

    command('lockfileDiff.showBranchChanges', async (arg?: unknown) => {
      const file = diskFile(arg);
      const repo = file ? await findRepo(file) : await pickRepo(arg);
      if (!repo) return;
      const branch = await repo.defaultBranch();
      const base: Rev | undefined = branch ? { kind: 'commit', ref: branch } : await pickRef(repo, 'Which branch does this one go into?');
      if (!base) return;
      // Always from the merge base: what this branch (and the working tree) adds on top of it.
      open({ parts: [repoPart(repo, file, base, WORKTREE, true)], left: revLabel(base), right: 'Working Tree' });
    }),

    historyView,
    history,
    command('lockfileDiff.showHistory', async (arg?: unknown) => {
      let file = diskFile(arg);
      if (file && !isLockfile(file.path)) file = undefined;
      // bun.lockb is binary: say so, as the comparison view does, instead of a list of errors.
      const unsupported = file && UNSUPPORTED[baseName(file.path)];
      if (unsupported) {
        void vscode.window.showInformationMessage(unsupported);
        return;
      }
      const repo = file ? await findRepo(file) : await pickRepo(arg);
      if (!repo) return;
      let rel = file ? path.relative(repo.root, file.fsPath) : undefined;
      if (!rel) {
        const tracked = (await repo.tracked()).filter((p) => isLockfile(p) && baseName(p) !== 'bun.lockb');
        if (!tracked.length) throw new GitError(`No lockfiles are tracked in ${path.basename(repo.root)}.`);
        rel = tracked.length === 1 ? tracked[0] : (await vscode.window.showQuickPick(tracked, { placeHolder: 'The history of which lockfile?' }));
        if (!rel) return;
      }
      await vscode.commands.executeCommand('setContext', 'lockfileDiff.historyOpen', true);
      const shown = history.show(repo, rel);
      await vscode.commands.executeCommand(`${HISTORY_VIEW}.focus`);
      await shown;
    }),
    command('lockfileDiff.historyMore', () => history.loadMore()),
    command('lockfileDiff.closeHistory', async () => {
      history.clear();
      await vscode.commands.executeCommand('setContext', 'lockfileDiff.historyOpen', false);
    }),
    command('lockfileDiff.openHistoryCommit', async (root: string, rel: string, commit: string, parent: string | null) => {
      const repo = await findRepo(vscode.Uri.file(root));
      const left: Rev = { kind: 'commit', ref: parent ?? (await repo.emptyTree()) };
      const right: Rev = { kind: 'commit', ref: commit };
      // One tab for the history, reused as the next commit is clicked.
      LockfilePanel.showHistory(context.extensionUri, { parts: [{ kind: 'repo', root: repo.root, files: [rel], left, right }], left: parent ? `${commit.slice(0, 8)}^` : 'empty', right: commit.slice(0, 8) });
    }),

    command('lockfileDiff.compareFiles', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const files = uris?.length ? uris : uri ? [uri] : [];
      if (files.length !== 2) {
        void vscode.window.showInformationMessage('Select two lockfiles in the Explorer, then choose Compare Lockfiles.');
        return;
      }
      const [a, b] = files;
      const rel = (u: vscode.Uri) => vscode.workspace.asRelativePath(u);
      const same = baseName(a.path) === baseName(b.path);
      open({ parts: [{ kind: 'uris', left: a.toString(), right: b.toString() }], left: same ? rel(a) : baseName(a.path), right: same ? rel(b) : baseName(b.path) });
    }),
  );
}

type RefPick = vscode.QuickPickItem & { rev?: Rev };

/** Branches, tags and recent commits; anything typed that isn't listed is used as a ref. */
async function pickRef(repo: GitRepo, title: string, withWorktree = false): Promise<Rev | undefined> {
  const [refs, log, head] = await Promise.all([repo.refs(), repo.log(30), repo.head()]);
  const items: RefPick[] = [];
  if (withWorktree) items.push({ label: '$(file-directory) Working Tree', description: 'your files as they are now', rev: { kind: 'worktree' } }, { label: '$(git-commit) Index', description: 'staged changes', rev: { kind: 'index' } });
  items.push({ label: '$(git-commit) HEAD', description: head ? `current: ${head}` : 'current commit', rev: { kind: 'commit', ref: 'HEAD' } });
  const section = (label: string) => items.push({ label, kind: vscode.QuickPickItemKind.Separator });
  const branches = refs.filter((r) => r.kind === 'branch');
  const remotes = refs.filter((r) => r.kind === 'remote');
  const tags = refs.filter((r) => r.kind === 'tag');
  if (branches.length) section('branches');
  for (const r of branches) items.push({ label: `$(git-branch) ${r.name}`, description: r.name === head ? 'current' : r.commit?.slice(0, 8), rev: { kind: 'commit', ref: r.name } });
  if (remotes.length) section('remote branches');
  for (const r of remotes) items.push({ label: `$(cloud) ${r.name}`, description: r.commit?.slice(0, 8), rev: { kind: 'commit', ref: r.name } });
  if (tags.length) section('tags');
  for (const r of tags) items.push({ label: `$(tag) ${r.name}`, description: r.commit?.slice(0, 8), rev: { kind: 'commit', ref: r.name } });
  if (log.length) section('recent commits');
  for (const c of log) items.push({ label: `$(git-commit) ${c.commit.slice(0, 8)}`, description: c.subject, detail: undefined, rev: { kind: 'commit', ref: c.commit } });

  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<RefPick>();
    qp.title = title;
    qp.placeholder = 'A branch, tag or commit; or type any ref (main~3, v1.2.0, a commit id)';
    qp.items = items;
    qp.matchOnDescription = true;
    let done = false;
    qp.onDidAccept(async () => {
      const picked = qp.selectedItems[0]?.rev;
      const typed = qp.value.trim();
      if (picked) {
        done = true;
        qp.hide();
        resolve(picked);
        return;
      }
      if (!typed) return;
      try {
        await repo.resolve(typed);
        done = true;
        qp.hide();
        resolve({ kind: 'commit', ref: typed });
      } catch (e) {
        // QuickPick has no validation message in the stable API: show it as the first row.
        const msg = e instanceof Error ? e.message : String(e);
        qp.items = [{ label: `$(warning) ${msg}`, alwaysShow: true }, ...items];
      }
    });
    qp.onDidChangeValue(() => {
      if (qp.items[0] !== items[0]) qp.items = items;
    });
    qp.onDidHide(() => {
      qp.dispose();
      if (!done) resolve(undefined);
    });
    qp.show();
  });
}

export function deactivate() {}
