import type { FileDiff } from './core/types';

export type Filter = 'all' | 'major' | 'upgraded' | 'downgraded' | 'added' | 'removed' | 'changed';

export interface ViewOptions {
  filter: Filter;
  directOnly: boolean;
}

export interface ViewData {
  /** "package-lock.json" or "4 lockfiles". */
  title: string;
  left: string;
  right: string;
  files: FileDiff[];
  /** When the comparison follows the working tree or index, it refreshes by itself. */
  live: boolean;
  /** Time the comparison took, in ms. */
  took: number;
  /** A message for the whole comparison, such as "No lockfiles changed". */
  message?: string;
  /** Things to say above the list, such as lockfiles a setting leaves out. */
  notices?: string[];
  /** For a comparison from a branch: whether it starts at the merge base, and whether that matters. */
  base?: { mode: 'mergeBase' | 'tips'; mergeBase?: string; diverged: boolean; unrelated?: boolean };
}

/** Which file of the comparison an action is about. */
export interface FileRef {
  /** The path as shown. */
  path: string;
  origin?: { part: number; rel: string; base?: string };
}

export type ToWebview =
  | { type: 'loading'; title: string; left: string; right: string }
  | { type: 'data'; data: ViewData; options?: ViewOptions; request?: unknown }
  | { type: 'error'; message: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'open'; url: string }
  | { type: 'copy'; text: string; what: string }
  | { type: 'textDiff'; file: FileRef }
  | { type: 'reveal'; file: FileRef; name: string; version?: string; side: 'left' | 'right' }
  | { type: 'state'; options: ViewOptions }
  | { type: 'setBase'; mergeBase: boolean };
