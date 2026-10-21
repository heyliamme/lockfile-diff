import { REGISTRY_NAMES } from '../src/core/registry';
import { summarize } from '../src/core/markdown';
import { count } from '../src/core/diff';
import { displayVersion } from '../src/core/version';
import type { Change, ChangeKind, FileDiff } from '../src/core/types';
import type { Filter } from '../src/protocol';

export interface ViewState {
  filter: Filter;
  directOnly: boolean;
  query: string;
  /** Keys of collapsed file and group rows. */
  collapsed: Set<string>;
}

export type Row =
  | { t: 'file'; key: string; fileIdx: number; file: FileDiff; shown: number; collapsed: boolean }
  | { t: 'group'; key: string; fileIdx: number; kind: ChangeKind; count: number; detail: string; collapsed: boolean }
  | { t: 'change'; key: string; fileIdx: number; change: Change }
  | { t: 'note'; key: string; fileIdx: number; text: string; level: 'info' | 'warn' | 'error' }
  | { t: 'empty'; key: string; text: string };

export const KINDS: ChangeKind[] = ['upgraded', 'downgraded', 'added', 'removed', 'changed'];
export const FILTERS: Filter[] = ['all', 'major', 'upgraded', 'downgraded', 'added', 'removed', 'changed'];

export const GROUP_LABEL: Record<ChangeKind, string> = {
  upgraded: 'Upgraded',
  downgraded: 'Downgraded',
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed without a version bump',
};

export const FILTER_LABEL: Record<Filter, string> = {
  all: 'All',
  major: 'Major',
  upgraded: 'Upgraded',
  downgraded: 'Downgraded',
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
};

export function passesFilter(c: Change, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'major') return c.bump === 'major';
  return c.kind === f;
}

/** Search and "direct only", which apply under every filter. */
export function passesScope(c: Change, s: Pick<ViewState, 'directOnly' | 'query'>, file: Pick<FileDiff, 'directKnown' | 'ecosystem'>): boolean {
  if (s.directOnly && file.directKnown && c.direct !== true) return false;
  const q = s.query.trim().toLowerCase();
  if (!q) return true;
  if (c.name.toLowerCase().includes(q) || !!c.alias?.toLowerCase().includes(q)) return true;
  // A version as stored, or as the view shows it (a Go commit: `5a60cdf (2024-06-06)`).
  return [c.from, c.to].some((v) => !!v && (v.toLowerCase().startsWith(q) || (displayVersion(file.ecosystem, v) !== v && displayVersion(file.ecosystem, v).toLowerCase().includes(q))));
}

/** How many changes each filter button would show, given the search and "direct only". */
export function filterCounts(files: FileDiff[], s: ViewState): Record<Filter, number> {
  const out = Object.fromEntries(FILTERS.map((f) => [f, 0])) as Record<Filter, number>;
  for (const file of files)
    for (const c of file.changes) {
      if (!passesScope(c, s, file)) continue;
      for (const f of FILTERS) if (passesFilter(c, f)) out[f]++;
    }
  return out;
}

/** The changes of each file the view currently shows (for "Copy as Markdown"). */
export function visibleChanges(files: FileDiff[], s: ViewState): FileDiff[] {
  return files.map((f) => ({ ...f, changes: f.changes.filter((c) => passesFilter(c, s.filter) && passesScope(c, s, f)) }));
}

function bumpDetail(changes: Change[]): string {
  const c = count(changes);
  const parts: string[] = [];
  for (const b of ['major', 'minor', 'patch', 'prerelease'] as const) if (c[b]) parts.push(`${c[b]} ${b}`);
  return parts.join(' · ');
}

export const registryName = (f: FileDiff) => REGISTRY_NAMES[f.ecosystem];

/** The flat list of rows the view draws: file headers (when there are several), groups and changes. */
export function buildRows(files: FileDiff[], s: ViewState): Row[] {
  const rows: Row[] = [];
  const many = files.length > 1;
  files.forEach((file, fileIdx) => {
    const visible = file.changes.filter((c) => passesFilter(c, s.filter) && passesScope(c, s, file));
    const fileKey = `f:${file.path}`;
    const fileCollapsed = many && s.collapsed.has(fileKey);
    if (many) rows.push({ t: 'file', key: fileKey, fileIdx, file, shown: visible.length, collapsed: fileCollapsed });
    if (fileCollapsed) return;
    if (file.error) {
      rows.push({ t: 'note', key: `${fileKey}:error`, fileIdx, text: file.error, level: 'error' });
      return;
    }
    (file.warnings ?? []).forEach((text, i) => rows.push({ t: 'note', key: `${fileKey}:warn${i}`, fileIdx, text, level: 'warn' }));
    file.notes.forEach((text, i) => rows.push({ t: 'note', key: `${fileKey}:note${i}`, fileIdx, text, level: 'info' }));
    if (!file.changes.length) {
      const text = file.lockUnchanged
        ? `The lockfile itself didn't change${file.unchanged ? ` (${file.unchanged} packages)` : ''}.`
        : `No dependency changes${file.unchanged ? `: all ${file.unchanged} packages are the same` : ''}. Only the lockfile's metadata changed, if anything.`;
      rows.push({ t: 'empty', key: `${fileKey}:none`, text });
      return;
    }
    if (!visible.length) {
      rows.push({ t: 'empty', key: `${fileKey}:filtered`, text: 'Nothing matches the filter here.' });
      return;
    }
    for (const kind of KINDS) {
      const of = visible.filter((c) => c.kind === kind);
      if (!of.length) continue;
      const key = `${fileKey}:g:${kind}`;
      const collapsed = s.collapsed.has(key);
      rows.push({ t: 'group', key, fileIdx, kind, count: of.length, detail: kind === 'upgraded' || kind === 'downgraded' ? bumpDetail(of.map((c) => ({ ...c, kind: 'upgraded' }))) : '', collapsed });
      if (collapsed) continue;
      for (const c of of) rows.push({ t: 'change', key: `${fileKey}:c:${c.kind}:${c.name}:${c.from ?? ''}:${c.to ?? ''}`, fileIdx, change: c });
    }
  });
  return rows;
}

/** One line for the whole comparison: "3 added, 1 removed, 12 upgraded (1 major)". */
export function overall(files: FileDiff[]): string {
  return summarize(count(files.flatMap((f) => f.changes)));
}

/**
 * Where each row sits in the tree the view exposes to assistive technology: its level, and
 * its position among its siblings (the list is virtualised, so this can't come from the DOM).
 */
export function treeInfo(rows: Row[]): { level: number; pos: number; size: number }[] {
  const many = rows.some((r) => r.t === 'file');
  const level = (r: Row) => {
    if (r.t === 'file' || (r.t === 'note' && r.fileIdx < 0) || r.key === 'message') return 1;
    const base = many ? 2 : 1;
    return r.t === 'change' ? base + 1 : base;
  };
  const out = rows.map((r) => ({ level: level(r), pos: 1, size: 1 }));
  const open: number[][] = [];
  const close = (from: number) => {
    for (let l = open.length - 1; l >= from; l--) open[l]?.forEach((idx, k, all) => Object.assign(out[idx], { pos: k + 1, size: all.length }));
    open.length = Math.min(open.length, from);
  };
  out.forEach((o, i) => {
    close(o.level + 1);
    (open[o.level] ??= []).push(i);
  });
  close(0);
  return out;
}
