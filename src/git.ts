import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

/** A side of a comparison in a repository. */
export type Rev = { kind: 'worktree' } | { kind: 'index' } | { kind: 'commit'; ref: string };

export interface RefItem {
  name: string;
  kind: 'branch' | 'remote' | 'tag';
  commit?: string;
}

/** The slice of the built-in Git extension's API this extension uses. */
interface ApiRepository {
  rootUri: vscode.Uri;
  state: { onDidChange: vscode.Event<void>; HEAD?: { name?: string; commit?: string } };
  show(ref: string, path: string): Promise<string>;
  getRefs?(query: { pattern?: string; sort?: string; count?: number }): Promise<{ type: number; name?: string; remote?: string; commit?: string }[]>;
}
interface GitApi {
  state: 'uninitialized' | 'initialized';
  git: { path: string };
  getRepository(uri: vscode.Uri): ApiRepository | null;
}

export interface LogEntry {
  commit: string;
  /** The first parent; undefined for a root commit. */
  parent?: string;
  author: string;
  date: Date;
  subject: string;
  /** Blob ids of the file before and after; all zeros where it didn't exist. */
  before: string;
  after: string;
}

export class GitError extends Error {}
/** The git program itself couldn't be started. */
export class GitNotFound extends GitError {}

export function requireTrust() {
  if (!vscode.workspace.isTrusted) {
    throw new GitError('Comparing with Git revisions needs a trusted workspace: Git does not run in Restricted Mode. You can still compare two lockfiles, or open a diff editor and use Show Dependency Changes there.');
  }
}

let apiPromise: Promise<GitApi | undefined> | undefined;

/** The built-in Git extension's API, or undefined when it is disabled or unavailable. */
export function gitApi(): Promise<GitApi | undefined> {
  apiPromise ??= (async () => {
    try {
      const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git');
      if (!ext) return undefined;
      const exports = ext.isActive ? ext.exports : await ext.activate();
      return exports.getAPI(1);
    } catch {
      return undefined;
    }
  })();
  return apiPromise;
}

const MAX_BUFFER = 512 * 1024 * 1024;

/** Runs git with an argument list (never a shell string). */
function run(gitPath: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      gitPath,
      ['-c', 'core.quotepath=off', '--no-optional-locks', ...args],
      { cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') reject(new GitNotFound(`Git was not found${gitPath === 'git' ? '' : ` at ${gitPath}`}. Install Git, or point the git.path setting at it.`));
        else if (err) reject(new GitError((stderr || err.message).trim().split('\n')[0]));
        else resolve(stdout);
      },
    );
  });
}

/** A ref git would read as an option (`--output=…`): never passed on. */
const optionLike = (ref: string) => ref.startsWith('-');

export class GitRepo {
  private indexPath?: Promise<string | undefined>;

  constructor(
    readonly root: string,
    private readonly gitPath: string,
    readonly api?: ApiRepository,
  ) {}

  /**
   * What HEAD and the index are now, cheaply: changes on a commit, a checkout, a stage or an
   * unstage, but not on a Git status run that found nothing new.
   */
  async stateKey(): Promise<string> {
    this.indexPath ??= this.git(['rev-parse', '--git-path', 'index']).then(
      (p) => path.resolve(this.root, p.trim()),
      () => undefined,
    );
    let index = '';
    const file = await this.indexPath;
    if (file) {
      try {
        const st = await vscode.workspace.fs.stat(vscode.Uri.file(file));
        index = `${st.mtime}:${st.size}`;
      } catch {
        // no index yet
      }
    }
    let head = this.api?.state.HEAD?.commit;
    if (head === undefined) {
      try {
        head = (await this.git(['rev-parse', '--verify', '--quiet', 'HEAD'])).trim();
      } catch {
        head = '';
      }
    }
    return `${head}|${index}`;
  }

  /** Fires when the repository's state (HEAD, index, working tree) changes, when known. */
  get onDidChange(): vscode.Event<void> | undefined {
    return this.api?.state.onDidChange;
  }

  private git(args: string[]) {
    return run(this.gitPath, args, this.root);
  }

  /** The text of `rel` (relative to the root) at a revision, or undefined when it isn't there. */
  async read(rev: Rev, rel: string): Promise<string | undefined> {
    const abs = path.join(this.root, rel);
    if (rev.kind === 'worktree') {
      const uri = vscode.Uri.file(abs);
      // Unsaved edits in an open editor count; otherwise the disk is the truth (an editor
      // may not have reloaded a file that just changed underneath it).
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (doc?.isDirty) return doc.getText();
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        return undefined;
      }
    }
    const ref = rev.kind === 'index' ? '' : rev.ref;
    if (typeof ref !== 'string' || optionLike(ref)) return undefined;
    if (this.api) {
      try {
        return await this.api.show(ref, abs);
      } catch {
        // Not at that revision, or the API refused: ask git directly below to tell which.
      }
    }
    try {
      return await this.git(['show', '--end-of-options', `${ref}:${rel.split(path.sep).join('/')}`]);
    } catch {
      return undefined;
    }
  }

  /** Full commit id for a ref; throws a readable error for a ref that doesn't exist. */
  async resolve(ref: string): Promise<string> {
    if (ref.startsWith('-')) throw new GitError(`"${ref}" is not a branch, tag or commit.`);
    try {
      return (await this.git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])).trim();
    } catch {
      throw new GitError(`"${ref}" is not a branch, tag or commit in ${path.basename(this.root)}.`);
    }
  }

  /** True when HEAD names a branch with no commits yet (a fresh `git init`). */
  async unborn(): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--verify', '--quiet', 'HEAD']);
      return false;
    } catch (e) {
      if (e instanceof GitNotFound) throw e;
    }
    try {
      await this.git(['symbolic-ref', '-q', 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  /** The empty tree, which stands for "no files" where a commit is expected. */
  async emptyTree(): Promise<string> {
    let format = 'sha1';
    try {
      format = (await this.git(['rev-parse', '--show-object-format'])).trim() || 'sha1';
    } catch {
      // older git: sha1
    }
    return format === 'sha256' ? '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321' : '4b825dc642cb6eb9a060af6e29d4cfdd5c4f9b1a';
  }

  /** An id for the content of `rel` at a revision: the commit for a ref, the blob for the index. */
  async contentId(rev: Rev, rel: string): Promise<string> {
    if (rev.kind === 'worktree') return '';
    if (rev.kind === 'commit' && optionLike(rev.ref)) return '';
    try {
      const spec = rev.kind === 'index' ? `:${rel.split(path.sep).join('/')}` : `${rev.ref}^{commit}`;
      return (await this.git(['rev-parse', '--verify', '--quiet', '--end-of-options', spec])).trim();
    } catch {
      return '';
    }
  }

  /** The best common ancestor of two commits, or undefined when they share no history. */
  async mergeBase(a: string, b: string): Promise<string | undefined> {
    try {
      return (await this.git(['merge-base', '--end-of-options', a, b])).trim().split('\n')[0] || undefined;
    } catch (e) {
      if (e instanceof GitNotFound) throw e;
      return undefined;
    }
  }

  /** The text of a blob by its id (from `lockfileLog`). */
  async blob(id: string): Promise<string> {
    return this.git(['cat-file', 'blob', id]);
  }

  /**
   * Commits on the current branch's first-parent line that changed `rel`, newest first, each
   * with the file's blob before and after (an all-zero id where it didn't exist). Merges
   * count with what they brought in, so a merged pull request is one entry.
   */
  async lockfileLog(rel: string, from: string, skip: number, max: number): Promise<LogEntry[]> {
    if (optionLike(from)) return [];
    const file = rel.split(path.sep).join('/');
    const args = ['log', '--first-parent', '-m', '--raw', '--no-abbrev', '--no-renames', '--no-color', `--skip=${skip}`, `--max-count=${max}`, '--format=%x1e%H%x00%P%x00%an%x00%at%x00%s', '--end-of-options', from, '--', file];
    let out: string;
    try {
      out = await this.git(args);
    } catch (e) {
      if (e instanceof GitNotFound) throw e;
      return []; // no commits yet
    }
    const entries: LogEntry[] = [];
    for (const chunk of out.split('\x1e').slice(1)) {
      const [head, ...rest] = chunk.split('\n');
      const [commit, parents, author, time, subject] = head.split('\0');
      // `:100644 100644 <old> <new> M\tpath`; a merge with -m lists a line per parent: the first parent's comes first.
      const raw = rest.find((l) => l.startsWith(':'));
      const m = raw && /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) /.exec(raw);
      if (!m) continue;
      entries.push({ commit, parent: parents.split(' ')[0] || undefined, author, date: new Date(Number(time) * 1000), subject, before: m[1], after: m[2] });
    }
    return entries;
  }

  /**
   * Which of `rels` exist at a revision, in one Git call per few hundred paths (not one
   * `git show` each): for probing the lockfiles that could sit next to changed manifests.
   */
  async existing(rev: Rev, rels: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    const posix = rels.map((r) => r.split(path.sep).join('/'));
    if (rev.kind === 'worktree') {
      await Promise.all(
        posix.map(async (r) => {
          try {
            await vscode.workspace.fs.stat(vscode.Uri.file(path.join(this.root, r)));
            out.add(r);
          } catch {
            // not there
          }
        }),
      );
      return out;
    }
    if (rev.kind === 'commit' && optionLike(rev.ref)) return out;
    for (let i = 0; i < posix.length; i += 200) {
      const chunk = posix.slice(i, i + 200);
      const args = rev.kind === 'index' ? ['ls-files', '-z', '--', ...chunk] : ['ls-tree', '--name-only', '-z', '--end-of-options', rev.ref, '--', ...chunk];
      try {
        for (const f of (await this.git(args)).split('\0')) if (f) out.add(f);
      } catch (e) {
        if (e instanceof GitNotFound) throw e;
      }
    }
    return out;
  }

  /** Lockfile-shaped paths tracked at HEAD, for picking one. */
  async tracked(): Promise<string[]> {
    try {
      return (await this.git(['ls-files', '-z'])).split('\0').filter(Boolean);
    } catch (e) {
      if (e instanceof GitNotFound) throw e;
      return [];
    }
  }

  /** Paths (relative to the root, with "/") that differ between two revisions. */
  async changed(from: Rev, to: Rev): Promise<string[]> {
    const spec = (r: Rev) => (r.kind === 'commit' ? r.ref : r.kind);
    const args = ['diff', '--name-only', '-z', '--no-renames'];
    const a = from.kind === 'commit' ? from.ref : undefined;
    const b = to.kind === 'commit' ? to.ref : undefined;
    // git diff A B (two commits) · git diff A (commit vs working tree) · --cached A (commit vs index)
    // · git diff (index vs working tree)
    if (a && b) args.push(a, b);
    else if (a && to.kind === 'worktree') args.push(a);
    else if (a && to.kind === 'index') args.push('--cached', a);
    else if (b && from.kind === 'worktree') args.push('-R', b);
    else if (b && from.kind === 'index') args.push('-R', '--cached', b);
    else if (from.kind === 'index' && to.kind === 'worktree') {
      /* plain git diff */
    } else throw new GitError(`Can't compare ${spec(from)} with ${spec(to)}.`);
    args.push('--');
    const out = (await this.git(args)).split('\0').filter(Boolean);
    // New files that aren't added yet only show up on the working tree side.
    if (to.kind === 'worktree' || from.kind === 'worktree') {
      const untracked = (await this.git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
      out.push(...untracked);
    }
    return [...new Set(out)];
  }

  /** Branches, remote branches and tags, most recent first where git can tell. */
  async refs(): Promise<RefItem[]> {
    if (this.api?.getRefs) {
      try {
        const refs = await this.api.getRefs({ sort: 'committerdate' });
        return refs
          .filter((r) => r.name)
          .map((r) => ({ name: r.remote && !r.name!.startsWith(`${r.remote}/`) ? `${r.remote}/${r.name}` : r.name!, kind: r.type === 0 ? 'branch' : r.type === 1 ? 'remote' : 'tag', commit: r.commit }) as RefItem)
          .filter((r) => !r.name.endsWith('/HEAD'));
      } catch {
        // fall through to git
      }
    }
    const out = await this.git(['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [ref, commit] = l.split('\0');
        const kind: RefItem['kind'] = ref.startsWith('refs/heads/') ? 'branch' : ref.startsWith('refs/remotes/') ? 'remote' : 'tag';
        return { name: ref.replace(/^refs\/(heads|remotes|tags)\//, ''), kind, commit };
      })
      .filter((r) => !r.name.endsWith('/HEAD'));
  }

  /** Recent commits for the picker: id, subject, relative date. */
  async log(count = 30): Promise<{ commit: string; subject: string; when: string }[]> {
    try {
      const out = await this.git(['log', `--max-count=${count}`, '--format=%H%x00%s%x00%cr']);
      return out
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [commit, subject, when] = l.split('\0');
          return { commit, subject, when };
        });
    } catch {
      return []; // an empty repository
    }
  }

  /**
   * The branch pull requests go into: what origin's HEAD points at, else a local or remote
   * main, master, trunk or develop. Undefined when there is no telling.
   */
  async defaultBranch(): Promise<string | undefined> {
    try {
      const r = (await this.git(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])).trim();
      if (r) return r;
    } catch (e) {
      if (e instanceof GitNotFound) throw e;
    }
    for (const name of ['main', 'master', 'trunk', 'develop']) {
      for (const ref of [`origin/${name}`, name]) {
        try {
          await this.git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
          return ref;
        } catch {
          // next
        }
      }
    }
    return undefined;
  }

  /** The current branch name, if any. */
  async head(): Promise<string | undefined> {
    if (this.api?.state.HEAD?.name) return this.api.state.HEAD.name;
    try {
      return (await this.git(['symbolic-ref', '--short', '-q', 'HEAD'])).trim() || undefined;
    } catch {
      return undefined;
    }
  }
}

const repos = new Map<string, GitRepo>();

/** The repository a file or folder belongs to. */
export async function findRepo(uri: vscode.Uri): Promise<GitRepo> {
  requireTrust();
  if (uri.scheme !== 'file') throw new GitError('Only files on disk can be compared with Git revisions.');
  const api = await gitApi();
  let apiRepo = api?.getRepository(uri) ?? undefined;
  // Right after startup Git is still discovering repositories: give it a moment.
  for (let waited = 0; api && !apiRepo && api.state !== 'initialized' && waited < 10_000; waited += 250) {
    await new Promise((r) => setTimeout(r, 250));
    apiRepo = api.getRepository(uri) ?? undefined;
  }
  const gitPath = api?.git.path || 'git';
  let root = apiRepo?.rootUri.fsPath;
  if (!root) {
    let dir = uri.fsPath;
    try {
      if ((await vscode.workspace.fs.stat(uri)).type !== vscode.FileType.Directory) dir = path.dirname(dir);
    } catch {
      dir = path.dirname(dir);
    }
    try {
      root = path.normalize((await run(gitPath, ['rev-parse', '--show-toplevel'], dir)).trim());
    } catch (e) {
      if (e instanceof GitNotFound) throw e;
      throw new GitError(`${path.basename(uri.fsPath)} is not in a Git repository.`);
    }
  }
  const key = `${root}\0${!!apiRepo}`;
  let repo = repos.get(key);
  // The Git extension makes a new repository object when one is closed and opened again:
  // the old one's events never fire again.
  if (!repo || repo.api !== apiRepo) repos.set(key, (repo = new GitRepo(root, gitPath, apiRepo)));
  return repo;
}

/** The repositories open in the workspace: from the Git extension, else each folder's. */
export async function workspaceRepos(): Promise<GitRepo[]> {
  requireTrust();
  const out = new Map<string, GitRepo>();
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    try {
      const r = await findRepo(f.uri);
      out.set(r.root, r);
    } catch (e) {
      if (e instanceof GitNotFound) throw e;
      // not a repository
    }
  }
  const api = await gitApi();
  for (const r of (api as unknown as { repositories?: ApiRepository[] })?.repositories ?? []) {
    if (!out.has(r.rootUri.fsPath)) {
      try {
        const repo = await findRepo(r.rootUri);
        out.set(repo.root, repo);
      } catch {
        // ignore
      }
    }
  }
  return [...out.values()];
}
