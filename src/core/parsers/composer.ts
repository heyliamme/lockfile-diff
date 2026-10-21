import { arr, isObj, LockfileError, obj, parseJson, str, stripBom } from '../text';
import type { LockedPackage, LockParser, ParsedLock } from '../types';

/** Platform requirements in composer.json that aren't packages. */
const platform = (n: string) => n === 'php' || /^(ext|lib)-/.test(n) || n === 'composer-plugin-api' || n === 'composer-runtime-api';

export const composer: LockParser = {
  id: 'composer',
  ecosystem: 'packagist',
  siblings: ['composer.json'],
  parse(text, { siblings }): ParsedLock {
    const doc = parseJson(text, 'composer.lock');
    if (!isObj(doc) || (!Array.isArray(doc.packages) && !Array.isArray(doc['packages-dev']))) throw new LockfileError("This doesn't look like a composer.lock file: it has no `packages`.");
    const packages: LockedPackage[] = [];
    for (const [list, dev] of [
      ['packages', false],
      ['packages-dev', true],
    ] as const) {
      for (const raw of arr(doc[list])) {
        const p = obj(raw);
        const name = str(p.name);
        let version = str(p.version);
        if (!name || !version) continue;
        const ref = str(obj(p.source).reference) ?? str(obj(p.dist).reference);
        // Branches (dev-main, 2.x-dev) move: the commit is what changed.
        if (/^dev-|-dev$/.test(version) && ref) version = `${version}#${ref.slice(0, 7)}`;
        packages.push({ name: name.toLowerCase(), version, dev: dev || undefined, integrity: str(obj(p.dist).shasum) || undefined });
      }
    }
    let direct: Set<string> | undefined;
    let directDev: Set<string> | undefined;
    const notes: string[] = [];
    const manifest = siblings['composer.json'];
    if (manifest !== undefined) {
      try {
        const m = obj(JSON.parse(stripBom(manifest)));
        direct = new Set(Object.keys(obj(m.require)).filter((n) => !platform(n)).map((n) => n.toLowerCase()));
        directDev = new Set(Object.keys(obj(m['require-dev'])).filter((n) => !platform(n)).map((n) => n.toLowerCase()));
        for (const n of direct) directDev.delete(n);
        for (const n of directDev) direct.add(n);
        notes.push('Direct dependencies come from composer.json.');
      } catch {
        notes.push("composer.json couldn't be read, so direct dependencies aren't marked.");
      }
    }
    return { format: 'composer.lock', ecosystem: 'packagist', packages, direct, directDev, devKnown: true, notes };
  },
};
