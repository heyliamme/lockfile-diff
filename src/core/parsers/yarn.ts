import { isObj, LockfileError, obj, packageJsonDeps, parseYaml, splitAt, str } from '../text';
import type { LockedPackage, LockParser, ParsedLock } from '../types';

const unquote = (s: string) => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, '$1') : s);

/** `"a@^1", a@~1.2` -> the specifiers, quotes removed. */
function specs(key: string): string[] {
  const out: string[] = [];
  for (const m of key.matchAll(/"((?:[^"\\]|\\.)*)"|([^,\s][^,]*)/g)) {
    const s = (m[1] ?? m[2] ?? '').trim();
    if (s) out.push(m[1] !== undefined ? s.replace(/\\(.)/g, '$1') : s);
  }
  return out;
}

function sourceOf(resolved: string | undefined): string | undefined {
  if (!resolved) return undefined;
  if (/^(git|github:|https:\/\/codeload|file:|link:)/.test(resolved) || /\.git(#|$)/.test(resolved)) return resolved.replace(/#.*$/, '');
  if (/^https?:/.test(resolved) && !/^https?:\/\/registry\.(yarnpkg\.com|npmjs\.org)\//.test(resolved)) {
    try {
      return new URL(resolved).host;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The names a merged entry is declared under. `"cjs@npm:string-width@^4", string-width@^4.1`
 * is string-width (declared under its own name too): no alias label, but `cjs` still counts
 * for direct dependencies and declared ranges. Labelled as an alias only when every
 * descriptor of the key is one.
 */
function aliasIn(descriptors: string[], name: string): Pick<LockedPackage, 'alias' | 'aliases'> {
  const asked = [...new Set(descriptors.map((d) => splitAt(d)[0]).filter(Boolean))];
  const others = asked.filter((n) => n !== name);
  if (!others.length) return {};
  return asked.includes(name) ? { aliases: others } : { alias: others[0], aliases: others.length > 1 ? others.slice(1) : undefined };
}

/** Yarn 1: its own indentation-based format. */
function classic(text: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  let cur: { name: string; names: Pick<LockedPackage, 'alias' | 'aliases'>; fields: Record<string, string> } | undefined;
  const flush = () => {
    if (cur?.fields.version) {
      const resolved = cur.fields.resolved;
      const source = sourceOf(resolved);
      // Only a git source's fragment is a commit; a tarball's is the sha1 of the tarball.
      const git = !!resolved && (/^(git[+:]|github:|gitlab:|bitbucket:)/.test(resolved) || /\.git#/.test(resolved));
      const hash = git ? /#([0-9a-f]{7,40})$/.exec(resolved) : null;
      const version = hash ? `${cur.fields.version}@${hash[1].slice(0, 7)}` : cur.fields.version;
      out.push({ name: cur.name, version, integrity: cur.fields.integrity, source, ...cur.names });
    }
    cur = undefined;
  };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      flush();
      if (!line.endsWith(':')) throw new LockfileError(`yarn.lock: unexpected line ${i + 1}: ${line.slice(0, 60)}`);
      const all = specs(line.slice(0, -1));
      const first = all[0];
      if (!first) throw new LockfileError(`yarn.lock: no package name on line ${i + 1}.`);
      // `"cjs@npm:string-width@^4"`: an alias of string-width.
      const [name, range] = splitAt(first);
      const real = range.startsWith('npm:') && /^(@?[^@]+)@/.exec(range.slice(4));
      const actual = real ? real[1] : name;
      cur = { name: actual, names: aliasIn(all, actual), fields: {} };
      continue;
    }
    // Two-space fields of the entry; deeper lines are its dependency lists.
    const m = /^ {2}(?! )("?[\w-]+"?)\s+(.*)$/.exec(line);
    if (cur && m) cur.fields[unquote(m[1])] = unquote(m[2].trim());
  }
  flush();
  return out;
}

/** Yarn 2+ ("berry"): YAML, with workspaces listed as entries of their own. */
function berry(doc: Record<string, unknown>, cacheKey: string) {
  const packages: LockedPackage[] = [];
  const direct = new Set<string>();
  for (const [key, raw] of Object.entries(doc)) {
    if (key === '__metadata' || !isObj(raw)) continue;
    const resolution = str(raw.resolution) ?? specs(key)[0] ?? '';
    const [name, rest] = splitAt(resolution);
    if (!name) continue;
    if (rest.startsWith('workspace:')) {
      for (const k of ['dependencies', 'peerDependencies', 'optionalDependencies']) for (const n of Object.keys(obj(raw[k]))) direct.add(n);
      continue;
    }
    if (rest.startsWith('patch:')) continue; // the same package with a patch applied; listed on its own too
    let version = str(raw.version);
    if (!version) continue;
    let source: string | undefined;
    if (!rest.startsWith('npm:')) {
      const commit = /#commit=([0-9a-f]{7,40})/.exec(rest);
      source = rest.replace(/#.*$/, '').replace(/\/\/[^/@]*@/, '//');
      if (commit) version = `${version}@${commit[1].slice(0, 7)}`;
    }
    // Checksums depend on the cache key: tag them with it so a new key isn't read as new contents.
    const checksum = str(raw.checksum)?.replace(/^\w+\//, '');
    // `"cjs@npm:string-width@^4"` resolves to string-width: installed as cjs.
    packages.push({ name, version, integrity: checksum ? `c${cacheKey}/${checksum}` : undefined, source, ...aliasIn(specs(key), name) });
  }
  return { packages, direct };
}

export const yarn: LockParser = {
  id: 'yarn',
  ecosystem: 'npm',
  siblings: ['package.json'],
  parse(text, { siblings }): ParsedLock {
    if (/^__metadata:/m.test(text)) {
      const doc = parseYaml(text, 'yarn.lock');
      if (!isObj(doc)) throw new LockfileError('yarn.lock is empty or not a mapping.');
      const meta = obj(doc.__metadata);
      const { packages, direct } = berry(doc, str(meta.cacheKey) ?? '');
      const manifest = packageJsonDeps(siblings['package.json']);
      return {
        format: `yarn.lock (Yarn 2+, v${str(meta.version) ?? '?'})`,
        ecosystem: 'npm',
        packages,
        direct: direct.size ? direct : manifest?.direct,
        directDev: manifest?.dev,
        notes: [],
      };
    }
    const packages = classic(text);
    if (!packages.length && /\S/.test(text.replace(/^#.*$/gm, ''))) throw new LockfileError("This doesn't look like a yarn.lock file.");
    const manifest = packageJsonDeps(siblings['package.json']);
    return {
      format: 'yarn.lock (Yarn 1)',
      ecosystem: 'npm',
      packages,
      direct: manifest?.direct,
      directDev: manifest?.dev,
      notes: manifest ? ['Direct dependencies come from package.json (the root one; workspaces are not read).'] : [],
    };
  },
};
