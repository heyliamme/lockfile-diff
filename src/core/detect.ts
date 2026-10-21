import { bun } from './parsers/bun';
import { cargo } from './parsers/cargo';
import { composer } from './parsers/composer';
import { go } from './parsers/go';
import { npm } from './parsers/npm';
import { pnpm } from './parsers/pnpm';
import { pub } from './parsers/pub';
import { poetry, uv } from './parsers/python';
import { ruby } from './parsers/ruby';
import { yarn } from './parsers/yarn';
import type { LockParser } from './types';

/** Lockfile base names and how to read each. */
export const LOCKFILES: Record<string, LockParser> = {
  'package-lock.json': npm,
  'npm-shrinkwrap.json': npm,
  'yarn.lock': yarn,
  'pnpm-lock.yaml': pnpm,
  'bun.lock': bun,
  'pubspec.lock': pub,
  'poetry.lock': poetry,
  'uv.lock': uv,
  'Cargo.lock': cargo,
  'go.sum': go,
  'go.mod': go,
  'composer.lock': composer,
  'Gemfile.lock': ruby,
  'gems.locked': ruby,
};

/** Recognized but not readable: said so instead of failing. */
export const UNSUPPORTED: Record<string, string> = {
  'bun.lockb':
    "bun.lockb is Bun's binary lockfile and can't be read as text. Bun 1.2 and later write bun.lock instead: run `bun install --save-text-lockfile` once to switch.",
};

export const baseName = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p;

export function parserFor(fileName: string): LockParser | undefined {
  return LOCKFILES[baseName(fileName)];
}

export function isLockfile(fileName: string): boolean {
  const b = baseName(fileName);
  return b in LOCKFILES || b in UNSUPPORTED;
}

/** One go.mod and go.sum pair is one comparison: prefer go.mod when both are given. */
export function dedupeGo(paths: string[]): string[] {
  const set = new Set(paths);
  return paths.filter((p) => !(baseName(p) === 'go.sum' && set.has(p.slice(0, -'go.sum'.length) + 'go.mod')));
}

type GlobToken = { t: 'lit'; c: string } | { t: 'one' } | { t: 'star' } | { t: 'globstar' } | { t: 'dirs' };

/** `{a,b}/x` -> `a/x`, `b/x`; at most 64 patterns, so a pattern can't blow up. */
function expandBraces(glob: string): string[] {
  const open = glob.indexOf('{');
  const close = open < 0 ? -1 : glob.indexOf('}', open);
  if (close < 0) return [glob];
  const out: string[] = [];
  for (const alt of glob.slice(open + 1, close).split(',')) {
    for (const rest of expandBraces(glob.slice(close + 1))) {
      out.push(glob.slice(0, open) + alt + rest);
      if (out.length >= 64) return out;
    }
  }
  return out;
}

function tokens(glob: string): GlobToken[] {
  const out: GlobToken[] = [];
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      let j = i;
      while (glob[j + 1] === '*') j++;
      const whole = j > i && (i === 0 || glob[i - 1] === '/');
      const start = i;
      i = j;
      // `**/` as a whole segment matches any number of folders, including none.
      if (whole && glob[i + 1] === '/') {
        i++;
        if (out[out.length - 1]?.t !== 'dirs') out.push({ t: 'dirs' });
      } else out.push(j > start ? { t: 'globstar' } : { t: 'star' });
    } else if (ch === '?') out.push({ t: 'one' });
    else out.push({ t: 'lit', c: ch });
  }
  return out;
}

/** Matches in time proportional to pattern length × path length, whatever the pattern. */
function matchTokens(toks: GlobToken[], p: string): boolean {
  const n = p.length;
  // next[j]: whether toks[i+1..] matches p[j..]; cur[j]: the same for toks[i..].
  let next = new Array<boolean>(n + 1).fill(false);
  next[n] = true;
  for (let i = toks.length - 1; i >= 0; i--) {
    const tok = toks[i];
    const cur = new Array<boolean>(n + 1).fill(false);
    let dirs = false; // toks[i+1..] matches right after some '/' at or after j
    for (let j = n; j >= 0; j--) {
      switch (tok.t) {
        case 'lit':
          cur[j] = j < n && p[j] === tok.c && next[j + 1];
          break;
        case 'one':
          cur[j] = j < n && p[j] !== '/' && next[j + 1];
          break;
        case 'star':
          cur[j] = next[j] || (j < n && p[j] !== '/' && cur[j + 1]);
          break;
        case 'globstar':
          cur[j] = next[j] || (j < n && cur[j + 1]);
          break;
        case 'dirs':
          if (j < n && p[j] === '/' && next[j + 1]) dirs = true;
          cur[j] = next[j] || dirs;
          break;
      }
    }
    next = cur;
  }
  return next[0];
}

/** `examples/**`, `**\/fixtures/**`, `*.lock`: whether a path relative to the repository root matches a glob. */
export function globMatch(glob: string, path: string): boolean {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  const p = path.replace(/\\/g, '/');
  if (g.length > 1000) return false;
  return expandBraces(g).some((one) => matchTokens(tokens(one), p));
}

/** True when a repository-relative path matches one of the patterns. */
export function excluded(path: string, patterns: string[]): boolean {
  return patterns.some((g) => globMatch(g, path));
}
