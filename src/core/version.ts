import type { Bump, Ecosystem } from './types';

/**
 * A version read leniently enough for every ecosystem the extension supports: semver
 * (npm, Cargo, pub), PEP 440 (`1.0rc1`, `1.0.post2`, `2!1.0`), RubyGems (`1.2.0.pre1`),
 * Composer (`v1.2.3-RC1`) and Go (`v1.2.3+incompatible`, pseudo-versions).
 */
export interface Version {
  epoch: number;
  /** Release numbers: `1.20.3` is [1, 20, 3]. */
  nums: number[];
  /** Pre-release identifiers, empty for a release. */
  pre: (string | number)[];
  /** PEP 440 post-release number, -1 when there is none. */
  post: number;
  /** PEP 440 development release number (`.dev3`), -1 when there is none. */
  dev: number;
  /** Build metadata after `+`; doesn't order versions, except as a last resort. */
  build: string;
}

/** PEP 440 spellings of pre-release tags, used only for PEP 440 shaped versions (`1.0rc1`). */
const PEP_PRE: Record<string, string> = { a: 'alpha', b: 'beta', c: 'rc', pre: 'rc', preview: 'rc' };

/**
 * Splits `rc1` into `rc`, 1 and `beta.2` into `beta`, 2. `pep` maps PEP 440's aliases
 * (`a`, `b`, `c`, `pre`, `preview`); semver and RubyGems tags are compared as written.
 */
function identifiers(s: string, pep: boolean): (string | number)[] {
  const out: (string | number)[] = [];
  for (const part of s.split(/[.\-_]/)) {
    if (!part) continue;
    for (const m of part.matchAll(/\d+|[^\d]+/g)) {
      const t = m[0];
      if (/^\d+$/.test(t)) out.push(t.length > 15 ? t : Number(t));
      else out.push((pep ? PEP_PRE[t.toLowerCase()] : undefined) ?? t.toLowerCase());
    }
  }
  return out;
}

export function parseVersion(input: string): Version | undefined {
  let s = input.trim();
  if (!s) return undefined;
  // A commit, not a version, even when it starts with digits: `2fca615`.
  if (/^[0-9a-f]{7,40}$/i.test(s) && /[a-f]/i.test(s)) return undefined;
  // `1.2.0@abc1234` (a version pinned to a commit): the commit is like build metadata.
  s = s.replace(/@([0-9a-f]{7,40})$/i, '+$1');
  let epoch = 0;
  const ep = /^(\d+)!/.exec(s);
  if (ep) {
    epoch = Number(ep[1]);
    s = s.slice(ep[0].length);
  }
  s = s.replace(/^[vV](?=\d)/, '');
  let build = '';
  const plus = s.indexOf('+');
  if (plus >= 0) {
    build = s.slice(plus + 1);
    s = s.slice(0, plus);
  }
  const m = /^(\d+(?:\.\d+)*)(.*)$/.exec(s);
  if (!m) return undefined;
  const nums = m[1].split('.').map(Number);
  if (nums.some((n) => !Number.isSafeInteger(n))) return undefined;
  let rest = m[2];
  // PEP 440 shape: the pre-release is glued to the release (`1.0rc1`, `2.0a1`) or there is
  // none, as opposed to semver's `-rc.1` and RubyGems' `.pre1`.
  const pep = !rest.startsWith('-');
  let dev = -1;
  const dm = pep ? /(?:^|\.|(?<=\d))dev(\d+)$/i.exec(rest) : null;
  if (dm) {
    dev = Number(dm[1]);
    rest = rest.slice(0, dm.index);
  }
  let post = -1;
  const pm = /(?:^|[.\-_])post[.\-_]?(\d*)$/i.exec(rest);
  if (pm) {
    post = Number(pm[1] || 0);
    rest = rest.slice(0, pm.index);
  }
  // A version that goes on with anything other than a separator or a letter (`1.0/abc`) isn't one.
  if (rest && !/^[.\-_]?[A-Za-z0-9]/.test(rest)) return undefined;
  if (rest && /[^A-Za-z0-9.\-_]/.test(rest)) return undefined;
  return { epoch, nums, pre: rest ? identifiers(rest, pep && /^[A-Za-z]/.test(rest)) : [], post, dev, build };
}

function cmpIdent(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1; // numeric identifiers sort before alphanumeric ones (semver)
  if (typeof b === 'number') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Orders two parsed versions: negative, zero or positive. */
export function compareParsed(a: Version, b: Version): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  const n = Math.max(a.nums.length, b.nums.length);
  for (let i = 0; i < n; i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (d) return d;
  }
  // PEP 440: 1.0.dev1 < 1.0a1 < 1.0 < 1.0.post1.dev1 < 1.0.post1. A release (with or
  // without a post) is newer than its pre-releases, which are newer than its bare dev releases.
  const rank = (v: Version) => (v.pre.length ? 1 : v.dev >= 0 && v.post < 0 ? 0 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.pre.length !== 0 || b.pre.length !== 0) {
    const m = Math.max(a.pre.length, b.pre.length);
    for (let i = 0; i < m; i++) {
      if (a.pre[i] === undefined) return -1;
      if (b.pre[i] === undefined) return 1;
      const d = cmpIdent(a.pre[i], b.pre[i]);
      if (d) return d;
    }
  }
  if (a.post !== b.post) return a.post - b.post;
  if (a.dev !== b.dev) return a.dev < 0 ? 1 : b.dev < 0 ? -1 : a.dev - b.dev;
  return 0;
}

/** Orders two version strings; ones that don't parse sort after those that do, then as text. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa && pb) return compareParsed(pa, pb) || (pa.build < pb.build ? -1 : pa.build > pb.build ? 1 : 0);
  if (pa) return -1;
  if (pb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isPrerelease(v: string): boolean {
  const p = parseVersion(v);
  return !!p && (p.pre.length > 0 || p.dev >= 0);
}

export interface Movement {
  /** 1 newer, -1 older, 0 same order (or not comparable). */
  direction: 1 | -1 | 0;
  bump: Bump;
}

/**
 * How a version moved. `1.4.2 → 2.0.0` is a major upgrade, `1.4.2 → 1.4.3-rc.1` a patch
 * upgrade, `2.0.0-rc.1 → 2.0.0` a prerelease one. Versions that aren't versions (git
 * commits, URLs, `dev-main`) are "other" with no direction.
 */
export function movement(from: string, to: string): Movement {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return { direction: 0, bump: 'other' };
  const c = compareParsed(a, b);
  const direction: 1 | -1 | 0 = c < 0 ? 1 : c > 0 ? -1 : 0;
  if (a.epoch !== b.epoch) return { direction, bump: 'major' };
  const n = Math.max(a.nums.length, b.nums.length, 3);
  for (let i = 0; i < n; i++) {
    if ((a.nums[i] ?? 0) !== (b.nums[i] ?? 0)) return { direction, bump: i === 0 ? 'major' : i === 1 ? 'minor' : 'patch' };
  }
  if (direction === 0) return { direction, bump: 'other' };
  if (a.pre.length || b.pre.length || a.dev >= 0 || b.dev >= 0) return { direction, bump: 'prerelease' };
  return { direction, bump: 'patch' }; // post-releases
}

/**
 * A Go pseudo-version: an untagged commit. `v0.0.0-20240102150405-abcdef123456` (no tag
 * before it), `v1.2.4-0.20240102150405-abcdef123456` (after v1.2.3) and
 * `v1.2.3-pre.0.20240102150405-abcdef123456` (after v1.2.3-pre).
 */
export interface Pseudo {
  /** The tag the commit comes after, when there is one. */
  base?: string;
  /** Commit time, `2024-01-02`. */
  date: string;
  /** The first 7 characters of the commit. */
  commit: string;
  /** Which of the three forms: the `vX.Y.(Z+1)-0.` one is a step past a release. */
  form: 'none' | 'release' | 'pre';
}

export function parsePseudo(v: string): Pseudo | undefined {
  const m = /^v(\d+)\.(\d+)\.(\d+)-(?:(.+?)\.0\.|(0)\.)?(\d{14})-([0-9a-f]{12})(?:\+incompatible)?$/.exec(v);
  if (!m) return undefined;
  const [, maj, min, pat, pre, zero, ts, hash] = m;
  const date = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
  if (pre) return { base: `v${maj}.${min}.${pat}-${pre}`, date, commit: hash.slice(0, 7), form: 'pre' };
  if (zero) return Number(pat) > 0 ? { base: `v${maj}.${min}.${Number(pat) - 1}`, date, commit: hash.slice(0, 7), form: 'release' } : undefined;
  return min === '0' && pat === '0' ? { date, commit: hash.slice(0, 7), form: 'none' } : undefined;
}

/** How a version reads in the view: a Go pseudo-version as its commit and date. */
export function displayVersion(ecosystem: Ecosystem, v: string | undefined): string {
  if (!v) return '';
  const p = ecosystem === 'go' ? parsePseudo(v) : undefined;
  return p ? `${p.commit} (${p.date})` : v;
}

/**
 * Which 0.x bumps an ecosystem treats as breaking. `caret`: semver's caret rule as npm,
 * Cargo and Composer apply it (0.2 → 0.3 and 0.0.3 → 0.0.4 are breaking). `minor`: only
 * 0.x minor bumps (pub; Go, whose v0 makes no compatibility promise at all). `none`:
 * versions mean what they say (PEP 440, RubyGems).
 */
const ZERO_RULE: Record<Ecosystem, 'caret' | 'minor' | 'none'> = { npm: 'caret', cargo: 'caret', packagist: 'caret', pub: 'minor', go: 'minor', pypi: 'none', rubygems: 'none' };
const RULE_NAME: Record<Ecosystem, string> = {
  npm: "npm's caret ranges",
  cargo: "Cargo's default (caret) requirements",
  packagist: "Composer's caret ranges",
  pub: "pub's caret constraints",
  go: 'Go modules',
  pypi: 'PEP 440',
  rubygems: 'RubyGems',
};

export interface Classified extends Movement {
  /** Why the bump reads as it does when that isn't plain semver: a 0.x breaking bump, a Go commit. */
  why?: string;
  /**
   * `breaking`: a 0.x bump the ecosystem's ranges treat as breaking (counted as major).
   * `v0`: a Go v0 module, which promises nothing. `commit`: Go pseudo-versions of untagged commits.
   */
  flag?: 'breaking' | 'v0' | 'commit';
}

/**
 * A version as an ecosystem orders it, for the generic comparison. Composer's `-p1`, `-pl1`
 * and `-patch1` are patch releases ranked above the plain version (Magento's `2.4.6-p1`),
 * not pre-releases: they read like a PEP 440 post-release.
 */
export function ecoVersion(ecosystem: Ecosystem, v: string): string {
  return ecosystem === 'packagist' ? v.replace(/-(?:patch|pl|p)\.?(\d*)$/i, '.post$1') : v;
}

/** `movement`, with what the ecosystem's conventions say about 0.x versions and Go pseudo-versions. */
export function classify(ecosystem: Ecosystem, rawFrom: string, rawTo: string): Classified {
  const from = ecoVersion(ecosystem, rawFrom);
  const to = ecoVersion(ecosystem, rawTo);
  const m: Classified = movement(from, to);
  if (ecosystem === 'go') {
    const a = parsePseudo(from);
    const b = parsePseudo(to);
    if (a || b) {
      const at = (v: string, p?: Pseudo) => (p ? `commit ${p.commit} (${p.date}${p.base ? `, after ${p.base}` : ''})` : v);
      const same = parseVersion(from)?.nums.join('.') === parseVersion(to)?.nums.join('.');
      // Two commits past the same tag: not a semver step at all. A commit after vX.Y.Z → vX.Y.(Z+1): a patch.
      if (same && a && b) m.bump = 'other';
      else if (same && (a ?? b)!.form === 'release') m.bump = 'patch';
      m.why = `${at(from, a)} → ${at(to, b)}`;
      m.flag = 'commit';
      if (!same || !(a && b)) return withZero(ecosystem, from, to, m);
      return m;
    }
  }
  return withZero(ecosystem, from, to, m);
}

function withZero(ecosystem: Ecosystem, from: string, to: string, m: Classified): Classified {
  const rule = ZERO_RULE[ecosystem];
  if (rule === 'none' || m.direction === 0) return m;
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b || a.epoch !== b.epoch || a.nums[0] !== 0 || b.nums[0] !== 0) return m;
  const minor = m.bump === 'minor';
  const patch00 = rule === 'caret' && m.bump === 'patch' && (a.nums[1] ?? 0) === 0 && (b.nums[1] ?? 0) === 0;
  if (!minor && !patch00) return m;
  const what = minor ? 'A 0.x minor version' : 'A 0.0.x patch version';
  const range = minor ? `^${a.nums.slice(0, 2).join('.')}` : `^0.0.${a.nums[2] ?? 0}`;
  // Go: nothing is promised below v1, but v0 minor upgrades are routine (golang.org/x/…): marked, not counted as major.
  if (ecosystem === 'go') {
    const reason = 'Go v0 modules make no compatibility promise: any v0 upgrade can break callers.';
    return { ...m, flag: m.flag ?? 'v0', why: m.why ? `${m.why}. ${reason}` : reason };
  }
  const reason = `${what} change is breaking under ${RULE_NAME[ecosystem]}: ${range} doesn't accept ${b.nums.slice(0, 3).join('.')}.`;
  return { direction: m.direction, bump: 'major', flag: 'breaking', why: m.why ? `${m.why}. ${reason}` : reason };
}
