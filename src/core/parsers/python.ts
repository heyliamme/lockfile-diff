import { arr, isObj, LockfileError, normalizePy, obj, parseTomlText, str } from '../text';
import type { LockedPackage, LockParser, ParsedLock } from '../types';

/** `requests[socks]>=2.0 ; python_version < "3.8"` -> `requests`. */
const reqName = (req: string) => normalizePy(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(req)?.[1] ?? '');

/** Direct dependencies declared in pyproject.toml, Poetry style and PEP 621 style. */
function pyproject(text: string | undefined): { direct: Set<string>; dev: Set<string> } | undefined {
  if (text === undefined) return undefined;
  let doc: Record<string, unknown>;
  try {
    doc = parseTomlText(text, 'pyproject.toml');
  } catch {
    return undefined;
  }
  const direct = new Set<string>();
  const dev = new Set<string>();
  const poetry = obj(obj(doc.tool).poetry);
  for (const n of Object.keys(obj(poetry.dependencies))) if (n.toLowerCase() !== 'python') direct.add(normalizePy(n));
  for (const n of Object.keys(obj(poetry['dev-dependencies']))) dev.add(normalizePy(n));
  for (const [group, g] of Object.entries(obj(poetry.group))) for (const n of Object.keys(obj(obj(g).dependencies))) (group === 'main' ? direct : dev).add(normalizePy(n));
  const project = obj(doc.project);
  for (const r of arr(project.dependencies)) if (typeof r === 'string') direct.add(reqName(r));
  for (const list of Object.values(obj(project['optional-dependencies']))) for (const r of arr(list)) if (typeof r === 'string') direct.add(reqName(r));
  for (const list of Object.values(obj(doc['dependency-groups']))) for (const r of arr(list)) if (typeof r === 'string') dev.add(reqName(r));
  // Dev only when not also a production dependency.
  for (const n of direct) dev.delete(n);
  for (const n of dev) direct.add(n);
  for (const n of direct) if (!n) direct.delete(n);
  return direct.size ? { direct, dev } : undefined;
}

export const poetry: LockParser = {
  id: 'poetry',
  ecosystem: 'pypi',
  siblings: ['pyproject.toml'],
  parse(text, { siblings }): ParsedLock {
    const doc = parseTomlText(text, 'poetry.lock');
    if (!Array.isArray(doc.package) && !isObj(doc.metadata)) throw new LockfileError("This doesn't look like a poetry.lock file.");
    const packages: LockedPackage[] = [];
    for (const raw of arr(doc.package)) {
      const p = obj(raw);
      const name = str(p.name);
      const version = str(p.version);
      if (!name || !version) continue;
      const src = obj(p.source);
      const type = str(src.type);
      let v = version;
      const ref = str(src.resolved_reference);
      if (type === 'git' && ref) v = `${version}@${ref.slice(0, 7)}`;
      packages.push({
        name: normalizePy(name),
        version: v,
        // Poetry 1.x: `category`; 2.x: `groups`, dev when "main" isn't one of them.
        dev: p.category === 'dev' || (Array.isArray(p.groups) && p.groups.length > 0 && !p.groups.includes('main')) || undefined,
        source: type && type !== 'legacy' ? str(src.url) : type === 'legacy' ? str(src.reference) : undefined,
      });
    }
    const manifest = pyproject(siblings['pyproject.toml']);
    const meta = obj(doc.metadata);
    // Poetry before 1.5 writes a category per package, 2.x the groups; 1.5 to 1.8 neither.
    const devKnown = arr(doc.package).some((p) => obj(p).category !== undefined || Array.isArray(obj(p).groups));
    return {
      format: `poetry.lock${str(meta['lock-version']) ? ` ${str(meta['lock-version'])}` : ''}`,
      ecosystem: 'pypi',
      packages,
      direct: manifest?.direct,
      directDev: manifest?.dev,
      devKnown,
      notes: manifest ? ['Direct dependencies come from pyproject.toml.'] : [],
    };
  },
};

export const uv: LockParser = {
  id: 'uv',
  ecosystem: 'pypi',
  parse(text): ParsedLock {
    const doc = parseTomlText(text, 'uv.lock');
    if (!Array.isArray(doc.package) && doc.version === undefined) throw new LockfileError("This doesn't look like a uv.lock file.");
    const packages: LockedPackage[] = [];
    const direct = new Set<string>();
    const directDev = new Set<string>();
    let roots = 0;
    for (const raw of arr(doc.package)) {
      const p = obj(raw);
      const name = str(p.name);
      if (!name) continue;
      const src = obj(p.source);
      // The project itself (and workspace members): what they depend on is direct.
      if (src.editable !== undefined || src.virtual !== undefined || src.workspace !== undefined) {
        roots++;
        for (const d of arr(p.dependencies)) direct.add(normalizePy(str(obj(d).name) ?? ''));
        for (const list of Object.values(obj(p['optional-dependencies']))) for (const d of arr(list)) direct.add(normalizePy(str(obj(d).name) ?? ''));
        for (const list of Object.values(obj(p['dev-dependencies']))) {
          for (const d of arr(list)) {
            const n = normalizePy(str(obj(d).name) ?? '');
            directDev.add(n);
            direct.add(n);
          }
        }
        continue;
      }
      const version = str(p.version);
      if (!version) continue;
      const git = str(src.git);
      const commit = git && /#([0-9a-f]{7,40})$/.exec(git);
      const sdist = obj(p.sdist);
      packages.push({
        name: normalizePy(name),
        version: commit ? `${version}@${commit[1].slice(0, 7)}` : version,
        integrity: str(sdist.hash),
        source: git ? git.replace(/[?#].*$/, '') : str(src.registry) && !/^https:\/\/pypi\.org\/simple\/?$/.test(str(src.registry)!) ? str(src.registry) : str(src.path) ?? str(src.directory) ?? str(src.url),
      });
    }
    direct.delete('');
    directDev.delete('');
    // Dev only when no member depends on it in production.
    const prodNames = new Set<string>();
    for (const raw of arr(doc.package)) {
      const p = obj(raw);
      const src = obj(p.source);
      if (src.editable === undefined && src.virtual === undefined && src.workspace === undefined) continue;
      for (const d of arr(p.dependencies)) prodNames.add(normalizePy(str(obj(d).name) ?? ''));
      for (const list of Object.values(obj(p['optional-dependencies']))) for (const d of arr(list)) prodNames.add(normalizePy(str(obj(d).name) ?? ''));
    }
    for (const n of prodNames) directDev.delete(n);
    return { format: `uv.lock v${str(doc.version) ?? '?'}`, ecosystem: 'pypi', packages, direct: roots ? direct : undefined, directDev, notes: [] };
  },
};
