import { isObj, LockfileError, obj, packageJsonDeps, parseJson, str } from '../text';
import type { LockedPackage, LockParser, ParsedLock } from '../types';

/** A dependency that isn't a registry version: a git commit, a tarball, a path. */
function sourceOf(version: string, resolved: string | undefined): string | undefined {
  if (/^(git|github:|gitlab:|bitbucket:|file:|link:|https?:)/.test(version)) return version.replace(/#.*$/, '');
  if (resolved && !/^https:\/\/registry\.(npmjs\.org|yarnpkg\.com)\//.test(resolved) && !/^(file:|link:)/.test(resolved)) {
    if (/^git/.test(resolved)) return resolved.replace(/#.*$/, '');
    try {
      return new URL(resolved).host; // another registry: show the host, never a token in the path
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const GIT = /^(git|github:|gitlab:|bitbucket:)/;

/**
 * A git dependency is its version plus the commit, `1.3.0@2fca615`, so a new commit reads
 * as a change. npm 6 records only the URL (`github:a/b#2fca615…`): then it is the commit.
 */
function versionOf(version: string, resolved?: string): string {
  const hash = /#([0-9a-f]{7,40})$/;
  // `@2fca615`: the marker keeps an all-digit commit (`@1234567`) from reading as a version.
  if (GIT.test(version)) {
    const h = hash.exec(version)?.[1];
    return h ? `@${h.slice(0, 7)}` : version;
  }
  const commit = resolved && GIT.test(resolved) ? hash.exec(resolved) : null;
  return commit ? `${version}@${commit[1].slice(0, 7)}` : version;
}

function v1(lock: Record<string, unknown>, out: LockedPackage[], aliases: Map<string, string>) {
  const walk = (deps: Record<string, unknown>, nested: boolean) => {
    for (const [name, raw] of Object.entries(deps)) {
      if (!isObj(raw)) continue;
      const version = str(raw.version);
      if (version && !version.startsWith('file:')) {
        // An alias (`"cjs": {"version": "npm:string-width@4.2.3"}`) is listed under the real name.
        const alias = /^npm:((?:@[^/@]+\/)?[^@]+)@(.+)$/.exec(version);
        out.push({
          name: alias ? alias[1] : name,
          version: alias ? alias[2] : versionOf(version, str(raw.resolved)),
          dev: raw.dev === true,
          integrity: str(raw.integrity),
          source: alias ? undefined : sourceOf(version, str(raw.resolved)),
          nested: nested || undefined,
          alias: alias ? name : undefined,
        });
        if (alias && !nested) aliases.set(name, alias[1]);
      }
      walk(obj(raw.dependencies), true);
    }
  };
  walk(obj(lock.dependencies), false);
}

export const npm: LockParser = {
  id: 'npm',
  ecosystem: 'npm',
  siblings: ['package.json'],
  parse(text, { fileName, siblings }): ParsedLock {
    const lock = parseJson(text, 'The lockfile');
    if (!isObj(lock)) throw new LockfileError('The lockfile is not a JSON object.');
    const lv = typeof lock.lockfileVersion === 'number' ? lock.lockfileVersion : 1;
    const packages: LockedPackage[] = [];
    const notes: string[] = [];
    let direct: Set<string> | undefined;
    let directDev: Set<string> | undefined;
    // Install folder name -> real package name, for aliases (`node_modules/cjs` is string-width).
    const aliases = new Map<string, string>();
    const local = new Set<string>();
    if (isObj(lock.packages)) {
      const prod = new Set<string>();
      const dev = new Set<string>();
      let sawRoot = false;
      for (const [path, raw] of Object.entries(lock.packages)) {
        if (!isObj(raw)) continue;
        const at = path.lastIndexOf('node_modules/');
        if (at < 0) {
          // The root project or a workspace: what it declares is direct.
          sawRoot = true;
          for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies']) for (const n of Object.keys(obj(raw[k]))) prod.add(n);
          for (const n of Object.keys(obj(raw.devDependencies))) dev.add(n);
          continue;
        }
        const folder = path.slice(at + 'node_modules/'.length);
        // A symlink to a workspace, not an installed package: declared, never locked as a version.
        if (raw.link === true) {
          if (folder && path.indexOf('node_modules/') === at) local.add(folder);
          continue;
        }
        const version = str(raw.version);
        if (!folder || !version) continue;
        // Below another package's node_modules: never a direct dependency.
        const nested = path.indexOf('node_modules/') !== at;
        const name = str(raw.name) ?? folder;
        if (name !== folder && !nested) aliases.set(folder, name);
        packages.push({
          name,
          version: versionOf(version, str(raw.resolved)),
          // Not devOptional: a dev dependency that is also an optional one of a production
          // package, which `npm install --omit=dev` still installs.
          dev: raw.dev === true,
          integrity: str(raw.integrity),
          source: sourceOf(version, str(raw.resolved)),
          nested: nested || undefined,
          alias: name !== folder ? folder : undefined,
        });
      }
      if (sawRoot) {
        direct = new Set([...prod, ...dev]);
        directDev = new Set([...dev].filter((n) => !prod.has(n)));
      }
    } else if (isObj(lock.dependencies)) {
      v1(lock, packages, aliases);
      const manifest = packageJsonDeps(siblings['package.json']);
      if (manifest) {
        direct = manifest.direct;
        directDev = manifest.dev;
        notes.push('Direct dependencies come from package.json.');
      }
    } else if (!('lockfileVersion' in lock)) {
      throw new LockfileError("This doesn't look like an npm lockfile: it has neither `packages` nor `dependencies`.");
    }
    // A direct alias makes the real package direct.
    for (const [folder, name] of aliases) {
      if (direct?.has(folder)) direct.add(name);
      if (directDev?.has(folder)) directDev.add(name);
    }
    return { format: `${fileName} v${lv}`, ecosystem: 'npm', packages, direct, directDev, devKnown: true, notes, local: local.size ? local : undefined };
  },
};
