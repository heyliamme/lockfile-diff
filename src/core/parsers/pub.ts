import { isObj, LockfileError, obj, parseYaml, str } from '../text';
import type { LockedPackage, LockParser, ParsedLock } from '../types';

/** pubspec.lock (Dart and Flutter). Each package says whether it is direct. */
export const pub: LockParser = {
  id: 'pub',
  ecosystem: 'pub',
  parse(text): ParsedLock {
    const doc = parseYaml(text, 'pubspec.lock');
    if (!isObj(doc) || !isObj(doc.packages)) {
      if (isObj(doc) && 'sdks' in doc) return { format: 'pubspec.lock', ecosystem: 'pub', packages: [], direct: new Set(), notes: [] };
      throw new LockfileError("This doesn't look like a pubspec.lock file: it has no `packages`.");
    }
    const packages: LockedPackage[] = [];
    const direct = new Set<string>();
    const directDev = new Set<string>();
    for (const [name, raw] of Object.entries(doc.packages)) {
      const e = obj(raw);
      const kind = str(e.dependency) ?? '';
      if (kind.startsWith('direct')) direct.add(name);
      if (kind === 'direct dev') directDev.add(name);
      const source = str(e.source);
      const desc = e.description;
      let version = str(e.version);
      if (!version) continue;
      let src: string | undefined;
      let integrity: string | undefined;
      if (source === 'git' && isObj(desc)) {
        const ref = str(desc['resolved-ref']);
        if (ref) version = `${version}@${ref.slice(0, 7)}`;
        src = str(desc.url);
      } else if (source === 'path') src = `path:${str(obj(desc).path) ?? ''}`;
      else if (source === 'sdk') src = `sdk:${typeof desc === 'string' ? desc : 'flutter'}`;
      else if (source === 'hosted') {
        const url = str(obj(desc).url);
        if (url && !/^https:\/\/pub\.(dev|dartlang\.org)\/?$/.test(url)) src = url;
        integrity = str(obj(desc).sha256);
      }
      packages.push({ name, version, dev: kind === 'direct dev' || undefined, integrity, source: src });
    }
    return { format: 'pubspec.lock', ecosystem: 'pub', packages, direct, directDev, notes: [] };
  },
};
