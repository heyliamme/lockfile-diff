/** The package registries the extension knows how to link to. */
export type Ecosystem = 'npm' | 'pub' | 'pypi' | 'cargo' | 'go' | 'packagist' | 'rubygems';

/** One resolved package in a lockfile. The same name can appear with several versions. */
export interface LockedPackage {
  name: string;
  version: string;
  /** True when the package is a dev-only dependency (where the lockfile records it). */
  dev?: boolean;
  /** Checksum or integrity string, to notice a package that changed without a version bump. */
  integrity?: string;
  /** Where it came from when that is not the default registry: a git URL, a path, another registry. */
  source?: string;
  /**
   * True when the parser knows this copy is installed below another package (npm's nested
   * `node_modules`), so it can't be a direct dependency whatever its name.
   */
  nested?: boolean;
  /** The name it is installed under when that is an alias (npm's `"cjs": "npm:string-width@4"`). */
  alias?: string;
  /**
   * Other names it is declared under, matched for direct and declared ranges but not shown:
   * Yarn's merged `"x-cjs@npm:x@^4", x@^4.1` is x (no alias label) and also x-cjs.
   */
  aliases?: string[];
}

/** What a parser read from one lockfile. */
export interface ParsedLock {
  /** Human name of the format, such as "package-lock.json v3" or "pnpm-lock.yaml 9.0". */
  format: string;
  ecosystem: Ecosystem;
  packages: LockedPackage[];
  /**
   * Names of direct dependencies, when the lockfile (or the manifest next to it) says.
   * Undefined means unknown: every row is shown without a direct/transitive mark.
   */
  direct?: Set<string>;
  /** Direct names that are dev dependencies (and not production ones anywhere). */
  directDev?: Set<string>;
  /**
   * True when each package's own `dev` flag is authoritative (npm, pnpm before 9, Poetry
   * categories, Composer): then `directDev` is not consulted for it.
   */
  devKnown?: boolean;
  /** Things the user should know, such as "direct dependencies read from package.json". */
  notes: string[];
  /** Names installed as links to local packages (npm workspaces): declared, never locked as a version. */
  local?: Set<string>;
}

/** Files a parser may want from next to the lockfile, at the same revision. */
export interface Siblings {
  /** File name (such as `package.json`) to its text; missing when it doesn't exist. */
  [fileName: string]: string | undefined;
}

export interface ParseContext {
  /** Base name of the lockfile, such as `npm-shrinkwrap.json`. */
  fileName: string;
  siblings: Siblings;
}

export interface LockParser {
  id: string;
  ecosystem: Ecosystem;
  /** Manifest files next to the lockfile that refine the result (direct dependencies). */
  siblings?: string[];
  /** The manifest whose declared ranges go with this lockfile, such as `package.json`. */
  manifest?: string;
  parse(text: string, ctx: ParseContext): ParsedLock;
}

export type ChangeKind = 'added' | 'removed' | 'upgraded' | 'downgraded' | 'changed';
export type Bump = 'major' | 'minor' | 'patch' | 'prerelease' | 'other';

export interface Change {
  name: string;
  kind: ChangeKind;
  from?: string;
  to?: string;
  /** How far the version moved (upgrades and downgrades). */
  bump?: Bump;
  /** True direct, false transitive, undefined unknown. */
  direct?: boolean;
  dev?: boolean;
  /** Short explanation, such as "integrity changed" or "another copy alongside 1.2.0". */
  note?: string;
  /** Registry page for the package (at the new version when there is one). */
  url?: string;
  /** Why the bump reads as it does when that isn't plain semver (a 0.x breaking bump, a Go commit). */
  why?: string;
  /** `breaking`: a 0.x bump counted as major; `v0`: a Go v0 module; `commit`: Go untagged commits. */
  flag?: 'breaking' | 'v0' | 'commit';
  /** The name it is installed under, when that is an alias of the real package. */
  alias?: string;
  /** Other names it is declared under (see LockedPackage.aliases). */
  aliases?: string[];
  /** The range the manifest declares, when it changed: `^17.0.2` → `^18.2.0`. */
  range?: { from?: string; to?: string };
}

/** A dependency whose declared range changed in the manifest next to the lockfile. */
export interface RangeChange {
  name: string;
  from?: string;
  to?: string;
  dev?: boolean;
}

export interface Counts {
  added: number;
  removed: number;
  upgraded: number;
  downgraded: number;
  changed: number;
  major: number;
  minor: number;
  patch: number;
  prerelease: number;
}

export interface FileDiff {
  /** Path of the lockfile, relative to the repository or workspace. */
  path: string;
  format: string;
  ecosystem: Ecosystem;
  changes: Change[];
  counts: Counts;
  /** Packages present on both sides with the same version. */
  unchanged: number;
  /** Whether direct/transitive is known for this file. */
  directKnown: boolean;
  notes: string[];
  /** Set when one side couldn't be read; changes are then empty. */
  error?: string;
  /** Problems worth a reviewer's attention, such as a manifest change the lockfile doesn't reflect. */
  warnings?: string[];
  /** The manifest next to the lockfile, when its declared dependencies changed. */
  manifest?: { file: string; ranges: RangeChange[] };
  /** True when the lockfile's text is the same on both sides (only its manifest changed). */
  lockUnchanged?: boolean;
  /** Where the file came from in a repository comparison: the part of the request, its path there, and the merge base used as its left side. */
  origin?: { part: number; rel: string; base?: string };
}
