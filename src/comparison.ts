import * as path from 'path';
import * as vscode from 'vscode';
import { analyze, baseName, dedupeGo, emptyCounts, excluded, isLockfile, LOCKS_OF, MANIFEST_OF, parserFor, rootLabels, type FileDiff, type SideText, type Siblings } from './core';
import { findRepo, type GitRepo, type Rev } from './git';

/**
 * What to compare, in a form that survives a window reload: either a range of a
 * repository (every changed lockfile, or the ones named), or two documents.
 */
export type Part =
  /**
   * `mergeBase`: the left side is where the right one branched off it (`git diff left...right`):
   * what the right side changes, without what happened on the left since.
   */
  | { kind: 'repo'; root: string; files?: string[]; left: Rev; right: Rev; mergeBase?: boolean }
  | { kind: 'uris'; left: string; right: string };

export interface Request {
  parts: Part[];
  left: string;
  right: string;
}

/** For a left side that is a branch: compare from the merge base, "what does this branch change". */
export const canMergeBase = (p: Part) => p.kind === 'repo' && p.left.kind === 'commit';

export const revLabel = (r: Rev) => (r.kind === 'worktree' ? 'Working Tree' : r.kind === 'index' ? 'Index' : /^[0-9a-f]{40}$/.test(r.ref) ? r.ref.slice(0, 8) : r.ref);

/** Settings for one repository: `exclude` can differ per folder of a multi-root workspace. */
export function readConfig(scope?: vscode.Uri) {
  const c = vscode.workspace.getConfiguration('lockfileDiff', scope);
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const i = c.inspect<unknown>('exclude');
  // A repository can set this in its own .vscode/settings.json: say so when it hides anything.
  const fromWorkspace = strings(i?.workspaceFolderValue).length > 0 || strings(i?.workspaceValue).length > 0;
  return { exclude: strings(c.get<unknown>('exclude')), fromWorkspace };
}

/** Manifests next to a lockfile at the same revision. */
async function siblings(fileName: string, read: (name: string) => Promise<string | undefined>): Promise<Siblings> {
  const out: Siblings = {};
  const names = new Set([...(parserFor(fileName)?.siblings ?? []), ...(MANIFEST_OF[fileName] ? [MANIFEST_OF[fileName]] : [])]);
  for (const s of names) if (s !== fileName) out[s] = await read(s);
  return out;
}

async function repoSide(repo: GitRepo, rev: Rev, rel: string): Promise<SideText> {
  const dir = path.dirname(rel);
  return {
    label: revLabel(rev),
    text: await repo.read(rev, rel),
    siblings: await siblings(baseName(rel), (s) => repo.read(rev, path.join(dir, s))),
  };
}

/** Text of any document VS Code can open (a file, a git: revision, another extension's scheme). */
async function documentText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    if (uri.scheme === 'file') {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (open?.isDirty) return open.getText();
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    }
    return (await vscode.workspace.openTextDocument(uri)).getText();
  } catch {
    return undefined;
  }
}

async function uriSide(uri: vscode.Uri, label: string): Promise<SideText> {
  const fileName = baseName(uri.path);
  const text = await documentText(uri);
  // Manifests next to the file: only for files on disk, where "next to" has a meaning.
  const sibs = uri.scheme === 'file' ? await siblings(fileName, (s) => documentText(vscode.Uri.joinPath(uri, '..', s))) : {};
  return { label, text, siblings: sibs, fileName };
}

/**
 * Changed lockfiles of a repository part, and those `lockfileDiff.exclude` leaves out. A
 * manifest that changed next to a lockfile that didn't brings that lockfile in too, so a
 * forgotten install shows up.
 */
export async function lockfilesIn(part: Extract<Part, { kind: 'repo' }>, repo: GitRepo): Promise<{ files: string[]; hidden: string[]; manifestOnly: Set<string> }> {
  if (part.files) return { files: part.files, hidden: [], manifestOnly: new Set() };
  const { exclude } = readConfig(vscode.Uri.file(part.root));
  const all = await repo.changed(part.left, part.right);
  const changed = dedupeGo(all.filter((p) => isLockfile(p)));
  const probe = new Set<string>();
  for (const m of all) {
    const locks = LOCKS_OF[baseName(m)];
    if (!locks) continue;
    const dir = path.posix.dirname(m);
    for (const l of locks) {
      const rel = dir === '.' ? l : `${dir}/${l}`;
      if (!changed.includes(rel)) probe.add(rel);
    }
  }
  // One Git call for every candidate, not a read of each.
  const there = probe.size ? await repo.existing(part.right, [...probe]) : new Set<string>();
  const manifestOnly = new Set([...probe].filter((rel) => there.has(rel)));
  const candidates = [...changed, ...manifestOnly];
  const hidden = candidates.filter((p) => excluded(p, exclude) && !manifestOnly.has(p));
  const files = candidates.filter((p) => !excluded(p, exclude)).sort((a, b) => parserFor(a)?.ecosystem.localeCompare(parserFor(b)?.ecosystem ?? '') || a.localeCompare(b));
  return { files, hidden, manifestOnly };
}

export interface RunResult {
  files: FileDiff[];
  /** Changed lockfiles left out by `lockfileDiff.exclude`, as shown paths. */
  hidden: string[];
  /** How the left side was taken, for a comparison from a branch. */
  base?: BaseInfo;
}

export interface BaseInfo {
  /** The merge base, when the comparison starts there. */
  mergeBase?: string;
  /** True when the two sides' histories diverged, so merge base and tip-to-tip differ. */
  diverged: boolean;
  /** Set when there is no common history: compared tip to tip whatever was asked. */
  unrelated?: boolean;
}

/** Turns HEAD of a repository without commits into the empty tree, so every file reads as new. */
const EMPTY_TREES = ['4b825dc642cb6eb9a060af6e29d4cfdd5c4f9b1a', '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'];

async function usable(repo: GitRepo, rev: Rev): Promise<Rev> {
  if (rev.kind !== 'commit' || EMPTY_TREES.includes(rev.ref)) return rev;
  try {
    await repo.resolve(rev.ref);
    return rev;
  } catch (e) {
    if (rev.ref === 'HEAD' && (await repo.unborn())) return { kind: 'commit', ref: await repo.emptyTree() };
    throw e;
  }
}

const failed = (shown: string, error: string): FileDiff => ({ path: shown, format: '', ecosystem: 'npm', changes: [], counts: emptyCounts(), unchanged: 0, directKnown: false, notes: [], error });

/**
 * Runs a comparison. Problems with one file end up in that file's `error`, and problems
 * with one repository of several in an entry for it; the others carry on.
 */
export async function run(req: Request): Promise<RunResult> {
  const out: FileDiff[] = [];
  const hidden: string[] = [];
  let base: BaseInfo | undefined;
  const roots = [...new Set(req.parts.filter((p) => p.kind === 'repo').map((p) => (p as { root: string }).root))];
  const labels = rootLabels(roots);
  const multiRepo = roots.length > 1;
  for (const [index, part] of req.parts.entries()) {
    if (part.kind === 'uris') {
      const l = vscode.Uri.parse(part.left);
      const r = vscode.Uri.parse(part.right);
      const [a, b] = await Promise.all([uriSide(l, req.left), uriSide(r, req.right)]);
      const name = baseName(r.path);
      const d = analyze(name, a, b);
      if (a.text === undefined && b.text === undefined) d.error = `Neither ${baseName(l.path)} nor ${name} could be read.`;
      out.push({ ...d, path: a.fileName !== b.fileName ? `${a.fileName} → ${b.fileName}` : name, origin: { part: index, rel: name } });
      continue;
    }
    const prefix = multiRepo ? `${labels.get(part.root)}/` : '';
    try {
      const repo = await findRepo(vscode.Uri.file(part.root));
      let left = await usable(repo, part.left);
      const right = await usable(repo, part.right);
      if (left.kind === 'commit' && !EMPTY_TREES.includes(left.ref) && canMergeBase(part)) {
        const tip = await repo.resolve(left.ref);
        const other = right.kind === 'commit' ? right.ref : 'HEAD';
        const mb = await repo.mergeBase(tip, other);
        // Only histories that really diverged start at the merge base. When one side contains
        // the other (the right one behind, too: `origin/main` after a fetch), tip to tip.
        const otherTip = mb && mb !== tip ? await repo.resolve(other).catch(() => undefined) : undefined;
        const diverged = !!mb && mb !== tip && mb !== otherTip;
        const info: BaseInfo = { diverged, unrelated: !mb || undefined };
        if (mb && diverged && part.mergeBase) {
          left = { kind: 'commit', ref: mb };
          info.mergeBase = mb;
        }
        base ??= info;
      }
      const found = await lockfilesIn({ ...part, left, right }, repo);
      hidden.push(...found.hidden.map((p) => prefix + p));
      const leftLabel = revLabel(part.left) + (left !== part.left && part.mergeBase ? ' (merge base)' : '');
      for (const rel of found.files) {
        const [a, b] = await Promise.all([repoSide(repo, left, rel), repoSide(repo, right, rel)]);
        a.label = leftLabel;
        b.label = revLabel(part.right);
        const d = analyze(rel, a, b);
        // A lockfile brought in only because its manifest changed: shown when the manifest's dependencies did.
        if (found.manifestOnly.has(rel) && !d.warnings?.length && !d.changes.length) continue;
        out.push({ ...d, path: prefix + rel.split(path.sep).join('/'), origin: { part: index, rel, base: left !== part.left && left.kind === 'commit' ? left.ref : undefined } });
      }
    } catch (e) {
      // One repository alone: the whole view says what went wrong.
      if (req.parts.length === 1) throw e;
      out.push(failed(labels.get(part.root) ?? path.basename(part.root), e instanceof Error ? e.message : String(e)));
    }
  }
  return { files: out, hidden, base };
}

/** Whether the comparison involves the working tree or the index, and so should follow edits. */
export function isLive(req: Request): boolean {
  return req.parts.some((p) => (p.kind === 'repo' ? [p.left, p.right].some((r) => r.kind !== 'commit') : vscode.Uri.parse(p.left).scheme === 'file' || vscode.Uri.parse(p.right).scheme === 'file'));
}
