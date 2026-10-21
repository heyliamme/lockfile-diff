import { arr, LockfileError, obj, parseTomlText, str } from '../text';
import type { LockedPackage, LockParser, ParsedLock } from '../types';

/** Cargo.lock. Packages without a `source` are the workspace's own crates. */
export const cargo: LockParser = {
  id: 'cargo',
  ecosystem: 'cargo',
  parse(text): ParsedLock {
    const doc = parseTomlText(text, 'Cargo.lock');
    if (!Array.isArray(doc.package)) throw new LockfileError("This doesn't look like a Cargo.lock file: it has no [[package]] entries.");
    const packages: LockedPackage[] = [];
    const direct = new Set<string>();
    let roots = 0;
    // name -> the versions a workspace crate names, or null where it names none (only one is locked).
    const directVersions = new Map<string, Set<string> | null>();
    const released = new Map<LockedPackage, string>();
    for (const raw of arr(doc.package)) {
      const p = obj(raw);
      const name = str(p.name);
      const version = str(p.version);
      if (!name || !version) continue;
      const source = str(p.source);
      if (!source) {
        roots++;
        // "serde 1.0.1 (registry+…)" or just "serde"; the version is there when several are locked.
        for (const d of arr(p.dependencies)) {
          if (typeof d !== 'string') continue;
          const [n, v] = d.split(' ');
          direct.add(n);
          if (directVersions.get(n) === null) continue;
          directVersions.set(n, v ? (directVersions.get(n) ?? new Set()).add(v) : null);
        }
        continue;
      }
      let v = version;
      let src: string | undefined;
      if (source.startsWith('git+')) {
        const commit = /#([0-9a-f]{7,40})$/.exec(source);
        if (commit) v = `${version}@${commit[1].slice(0, 7)}`;
        src = source.replace(/[?#].*$/, '');
      } else if (!/^(registry|sparse)\+https:\/\/(github\.com\/rust-lang\/crates\.io-index|index\.crates\.io\/)/.test(source)) src = source;
      packages.push({ name, version: v, integrity: str(p.checksum), source: src });
      released.set(packages[packages.length - 1], version);
    }
    // A root that names `syn 2.0.50` depends on that copy; other versions of syn are transitive.
    for (const pkg of packages) {
      const vs = directVersions.get(pkg.name);
      if (vs && !vs.has(released.get(pkg)!)) pkg.nested = true;
    }
    return { format: `Cargo.lock v${str(doc.version) ?? '1'}`, ecosystem: 'cargo', packages, direct: roots ? direct : undefined, notes: [] };
  },
};
