import { isObj, LockfileError, obj, parseYaml, splitAt, str } from '../text';
import type { LockedPackage, LockParser, ParsedLock } from '../types';

/** Name and version from a `packages:` key, for each generation of the format. */
function fromKey(key: string, major: number): [string, string] | undefined {
  let k = key.replace(/^\//, '');
  if (major >= 6) {
    const paren = k.indexOf('(');
    if (paren > 0) k = k.slice(0, paren);
    const [name, version] = splitAt(k);
    return name && version ? [name, version] : undefined;
  }
  // 5.x: /name/1.0.0 or /@scope/name/1.0.0_peer@1.0.0
  const parts = k.split('/');
  const scoped = parts[0].startsWith('@');
  const name = scoped ? `${parts[0]}/${parts[1]}` : parts[0];
  const version = parts[scoped ? 2 : 1];
  if (!name || !version || parts.length !== (scoped ? 3 : 2)) return undefined;
  return [name, version.replace(/_.*$/, '')];
}

/**
 * A tarball of one commit of a git host (`https://codeload.github.com/o/r/tar.gz/<sha>`,
 * GitLab's `/-/archive/<sha>/…`, `/archive/<sha>.tar.gz`): the repository and the commit.
 */
function gitTarball(url: string): { repo: string; commit: string } | undefined {
  const m = /^(.*?)\/(?:tar\.gz|tarball|zipball|(?:-\/)?archive)\/([0-9a-f]{7,40})(?:[./][^/]*)?$/i.exec(url.replace(/[?#].*$/, ''));
  return m ? { repo: m[1], commit: m[2].toLowerCase() } : undefined;
}

function sourceOf(resolution: Record<string, unknown>): string | undefined {
  const tarball = str(resolution.tarball);
  if (tarball) {
    if (/^file:/.test(tarball)) return tarball;
    const git = gitTarball(tarball);
    if (git) return git.repo;
    try {
      const u = new URL(tarball);
      // Another registry: its host. The full URL names the version, so it would differ on every upgrade.
      return /(^|\.)npmjs\.org$|(^|\.)yarnpkg\.com$/.test(u.hostname) ? undefined : u.host;
    } catch {
      return tarball;
    }
  }
  const repo = str(resolution.repo);
  if (repo) return repo.replace(/\/\/[^/@]*@/, '//');
  const dir = str(resolution.directory);
  return dir ? `file:${dir}` : undefined;
}

/**
 * The real package behind an importer entry that is an npm alias: the resolved version reads
 * `string-width@4.2.3` (pnpm 6+) or `/string-width/4.2.3` (pnpm 5) instead of `4.2.3`.
 */
function aliasOf(spec: unknown): { name: string; version: string } | undefined {
  const v = (isObj(spec) ? str(spec.version) : str(spec))?.replace(/\(.*$/, '');
  if (!v || /^(link|file|workspace):/.test(v)) return undefined;
  const k = v.replace(/^\//, '');
  const [name, version] = splitAt(k);
  if (version && name && !/^\d/.test(name)) return { name, version: version.replace(/_.*$/, '') };
  const slash = /^((?:@[^/]+\/)?[^/@]+)\/(\d[^/]*)$/.exec(k);
  return v.startsWith('/') && slash ? { name: slash[1], version: slash[2].replace(/_.*$/, '') } : undefined;
}

export const pnpm: LockParser = {
  id: 'pnpm',
  ecosystem: 'npm',
  parse(text): ParsedLock {
    const doc = parseYaml(text, 'pnpm-lock.yaml');
    if (!isObj(doc)) throw new LockfileError('pnpm-lock.yaml is empty or not a mapping.');
    const lv = str(doc.lockfileVersion);
    if (!lv) throw new LockfileError("This doesn't look like a pnpm lockfile: it has no lockfileVersion.");
    const major = parseFloat(lv);
    const packages: LockedPackage[] = [];
    for (const [key, raw] of Object.entries(obj(doc.packages))) {
      const entry = obj(raw);
      const parsed = fromKey(key, major);
      const name = str(entry.name) ?? parsed?.[0];
      let version = str(entry.version) ?? parsed?.[1];
      if (!name || !version) continue;
      const resolution = obj(entry.resolution);
      // A git dependency: by its commit, from `commit` or from the commit tarball pnpm fetched.
      const commit = str(resolution.commit) ?? gitTarball(str(resolution.tarball) ?? '')?.commit;
      if (commit) version = `${version}@${commit.slice(0, 7)}`;
      packages.push({ name, version, dev: entry.dev === 'true', integrity: str(resolution.integrity), source: sourceOf(resolution) });
    }
    // Direct dependencies: each importer (workspace project), or the top level of a single project.
    const projects = isObj(doc.importers) ? Object.values(doc.importers).map(obj) : [doc];
    const prod = new Set<string>();
    const dev = new Set<string>();
    // Real `name@version` -> the alias a project installs it under.
    const aliases = new Map<string, string>();
    // name -> the versions projects depend on directly; undefined once one can't be read.
    const directVersions = new Map<string, Set<string> | undefined>();
    const noteVersion = (name: string, v: string | undefined) => {
      if (directVersions.has(name) && !directVersions.get(name)) return;
      if (!v || !/^\d/.test(v)) return void directVersions.set(name, undefined);
      directVersions.set(name, (directVersions.get(name) ?? new Set()).add(v));
    };
    for (const p of projects) {
      for (const [k, into] of [
        ['dependencies', prod],
        ['optionalDependencies', prod],
        ['devDependencies', dev],
      ] as const) {
        for (const [n, spec] of Object.entries(obj(p[k]))) {
          into.add(n);
          const real = aliasOf(spec);
          if (real) {
            into.add(real.name);
            aliases.set(`${real.name}@${real.version}`, n);
            noteVersion(real.name, real.version);
          } else {
            // `4.3.4`, `4.3.4(react@18.2.0)` (pnpm 6+), `4.3.4_react@18.2.0` (pnpm 5)
            const v = (isObj(spec) ? str(spec.version) : str(spec))?.replace(/\(.*$/, '').replace(/_.*$/, '');
            noteVersion(n, v && /^\d+\.\d+\.\d+(?:[-+][\w.+-]*)?$/.test(v) ? v : undefined);
          }
        }
      }
    }
    for (const p of packages) {
      p.alias = aliases.get(`${p.name}@${p.version}`);
      // Another version of a direct dependency's name: a transitive copy.
      const versions = directVersions.get(p.name);
      if (versions && !p.alias && !versions.has(p.version.replace(/@[0-9a-f]{7}$/, ''))) p.nested = true;
    }
    const direct = new Set([...prod, ...dev]);
    const directDev = new Set([...dev].filter((n) => !prod.has(n)));
    // Before pnpm 9 each package says whether it is dev-only; 9 dropped that.
    const devKnown = major < 9 && Object.values(obj(doc.packages)).some((e) => 'dev' in obj(e));
    return { format: `pnpm-lock.yaml ${lv}`, ecosystem: 'npm', packages, direct, directDev, devKnown, notes: [] };
  },
};
