import { LockfileError } from '../text';
import type { LockedPackage, LockParser, ParsedLock } from '../types';

interface Require {
  path: string;
  version: string;
  indirect: boolean;
}

const unquote = (s: string) => (/^".*"$/.test(s) ? s.slice(1, -1) : s.replace(/^`(.*)`$/, '$1'));

interface Replace {
  path: string;
  /** Only this version is replaced; undefined replaces every version. */
  version?: string;
  to: string;
  toVersion?: string;
}

/** The lines of one kind of directive (`require`, `replace`), single-line and in blocks, as words. */
function directives(text: string, verb: string): { words: string[]; comment: string }[] {
  const out: { words: string[]; comment: string }[] = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const comment = /\/\/(.*)$/.exec(raw)?.[1] ?? '';
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (inBlock) {
      if (line === ')') inBlock = false;
      else out.push({ words: line.split(/\s+/), comment });
      continue;
    }
    if (new RegExp(`^${verb}\\s*\\($`).test(line)) {
      inBlock = true;
      continue;
    }
    const m = new RegExp(`^${verb}\\s+(.*)$`).exec(line);
    if (m) out.push({ words: m[1].trim().split(/\s+/), comment });
  }
  return out;
}

/** The `require` directives of a go.mod, single-line and in blocks. */
export function goModRequires(text: string): Require[] {
  const out: Require[] = [];
  for (const { words, comment } of directives(text, 'require')) {
    const [p, v] = words;
    if (p && v) out.push({ path: unquote(p), version: v, indirect: /^\s*indirect\b/.test(comment) });
  }
  return out;
}

/** `replace a/b [v1.2.3] => c/d v1.4.0` and `replace a/b => ../local`. */
export function goModReplaces(text: string): Replace[] {
  const out: Replace[] = [];
  for (const { words } of directives(text, 'replace')) {
    const arrow = words.indexOf('=>');
    if (arrow < 1 || arrow > 2 || !words[arrow + 1]) continue;
    out.push({ path: unquote(words[0]), version: arrow === 2 ? words[1] : undefined, to: unquote(words[arrow + 1]), toVersion: words[arrow + 2] });
  }
  return out;
}

const isLocal = (p: string) => /^(\.{1,2}[\\/]|\/|[A-Za-z]:[\\/])/.test(p) || p === '.' || p === '..';

function fromGoMod(text: string): Pick<ParsedLock, 'packages' | 'direct'> {
  const reqs = goModRequires(text);
  if (!reqs.length && !/^\s*module\s/m.test(text)) throw new LockfileError("This doesn't look like a go.mod file: it has no module line.");
  const replaces = goModReplaces(text);
  const packages = reqs.map((r): LockedPackage => {
    // A version-specific replacement wins over one for every version.
    const rep = replaces.find((x) => x.path === r.path && x.version === r.version) ?? replaces.find((x) => x.path === r.path && x.version === undefined);
    if (!rep) return { name: r.path, version: r.version };
    // What builds is the replacement: its version, and where it comes from when that isn't the module itself.
    if (isLocal(rep.to)) return { name: r.path, version: r.version, source: `replaced by ${rep.to}` };
    return { name: r.path, version: rep.toVersion ?? r.version, source: rep.to === r.path ? undefined : `replaced by ${rep.to}` };
  });
  return { packages, direct: new Set(reqs.filter((r) => !r.indirect).map((r) => r.path)) };
}

/**
 * Go modules. go.mod lists the selected version of every module the build uses (Go 1.17+),
 * so it is the source of truth when it is there; go.sum alone keeps every version ever
 * consulted, so it is only the fallback.
 */
export const go: LockParser = {
  id: 'go',
  ecosystem: 'go',
  siblings: ['go.mod'],
  parse(text, { fileName, siblings }): ParsedLock {
    const mod = fileName === 'go.mod' ? text : siblings['go.mod'];
    if (mod !== undefined) {
      const r = fromGoMod(mod);
      return { format: 'go.mod', ecosystem: 'go', ...r, notes: fileName === 'go.sum' ? ['Versions come from go.mod, which records the selected version of each module.'] : [] };
    }
    const packages: LockedPackage[] = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const [path, version, hash] = line.split(/\s+/);
      if (!path || !version || !hash?.startsWith('h1:')) throw new LockfileError(`go.sum: unexpected line ${i + 1}: ${line.slice(0, 60)}`);
      if (version.endsWith('/go.mod')) continue; // only the module's go.mod was consulted, not its code
      packages.push({ name: path, version, integrity: hash });
    }
    return { format: 'go.sum', ecosystem: 'go', packages, notes: ['No go.mod next to go.sum: versions come from go.sum, which can list several versions of a module.'] };
  },
};
