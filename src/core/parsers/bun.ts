import { arr, isObj, LockfileError, obj, parseJsonc, splitAt, str } from '../text';
import type { LockedPackage, LockParser, ParsedLock } from '../types';

/**
 * Keys are install paths: `cjs-sw`, or `parent/child` for a nested copy. A last segment
 * that isn't the package's name is an alias (`"cjs-sw": ["string-width@4.2.3", …]`).
 */
function aliasOf(key: string, name: string): string | undefined {
  if (key === name || key.endsWith(`/${name}`)) return undefined;
  const segs = key.split('/');
  const last = segs[segs.length - 2]?.startsWith('@') ? segs.slice(-2).join('/') : segs[segs.length - 1];
  return last && last !== name ? last : undefined;
}

/** `send/debug`, `@a/b/debug`: installed below another package (beyond a scope or a workspace). */
function nestedKey(key: string, workspaces: Set<string>): boolean {
  const segs = key.split('/');
  const first = segs[0].startsWith('@') ? 2 : 1;
  if (segs.length <= first) return false;
  const parent = segs.slice(0, first).join('/');
  // A workspace's own dependency, at the top of that workspace.
  if (workspaces.has(parent)) {
    const rest = segs.slice(first);
    return rest.length > (rest[0].startsWith('@') ? 2 : 1);
  }
  return true;
}

/** bun.lock, the text lockfile of Bun 1.2+ (JSON with trailing commas). */
export const bun: LockParser = {
  id: 'bun',
  ecosystem: 'npm',
  parse(text): ParsedLock {
    const doc = parseJsonc(text, 'bun.lock');
    if (!isObj(doc) || !isObj(doc.packages)) throw new LockfileError("This doesn't look like a bun.lock file: it has no `packages`.");
    const packages: LockedPackage[] = [];
    // Workspaces' own packages: `ws/dep` is that workspace's direct dependency, not a nested copy.
    const workspaces = new Set<string>();
    for (const [key, raw] of Object.entries(doc.packages)) if (/@workspace:/.test(str(arr(raw)[0]) ?? '')) workspaces.add(key);
    for (const [key, raw] of Object.entries(doc.packages)) {
      const tuple = arr(raw);
      const id = str(tuple[0]);
      if (!id) continue;
      const [name, rest] = splitAt(id);
      if (!name || !rest || /^(workspace|link):/.test(rest)) continue;
      const npm = !/^(github:|git\+|git:|https?:|file:)/.test(rest);
      const last = tuple[tuple.length - 1];
      const integrity = npm && typeof last === 'string' && /^sha\d+-/.test(last) ? last : undefined;
      const commit = /#([0-9a-f]{7,40})$/.exec(rest);
      packages.push({
        name,
        // `@2fca615`: the marker keeps an all-digit commit from reading as a version.
        version: npm ? rest.replace(/^npm:/, '') : commit ? `@${commit[1].slice(0, 7)}` : rest,
        integrity,
        source: npm ? undefined : rest.replace(/#.*$/, ''),
        alias: aliasOf(key, name),
        nested: nestedKey(key, workspaces) || undefined,
      });
    }
    const prod = new Set<string>();
    const dev = new Set<string>();
    for (const ws of Object.values(obj(doc.workspaces)).map(obj)) {
      for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies']) for (const n of Object.keys(obj(ws[k]))) prod.add(n);
      for (const n of Object.keys(obj(ws.devDependencies))) dev.add(n);
    }
    // Dev only when no workspace depends on it in production.
    const direct = new Set([...prod, ...dev]);
    const directDev = new Set([...dev].filter((n) => !prod.has(n)));
    return { format: `bun.lock v${str(doc.lockfileVersion) ?? '?'}`, ecosystem: 'npm', packages, direct, directDev, notes: [] };
  },
};
