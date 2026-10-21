import { LockfileError } from '../text';
import type { LockedPackage, LockParser, ParsedLock } from '../types';

/**
 * Gemfile.lock. Gems are listed under `specs:` in the GEM, GIT and PATH sections; the
 * DEPENDENCIES section names the direct ones.
 */
const PLATFORM = /^(?:x86|x64|arm|aarch|universal|java|mswin|mingw|darwin|linux|wasm)/;

export const ruby: LockParser = {
  id: 'ruby',
  ecosystem: 'rubygems',
  parse(text, { fileName }): ParsedLock {
    const packages: LockedPackage[] = [];
    const direct = new Set<string>();
    let section = '';
    let remote: string | undefined;
    let revision: string | undefined;
    let inSpecs = false;
    let sawSection = false;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) {
        inSpecs = false;
        continue;
      }
      if (/^[A-Z]/.test(line)) {
        section = line.trim();
        sawSection = true;
        remote = revision = undefined;
        inSpecs = false;
        continue;
      }
      if (section === 'GEM' || section === 'GIT' || section === 'PATH' || section === 'PLUGIN SOURCE') {
        const field = /^ {2}(\w[\w-]*):\s*(.*)$/.exec(line);
        if (field) {
          if (field[1] === 'specs') inSpecs = true;
          else if (field[1] === 'remote') remote = field[2].trim();
          else if (field[1] === 'revision') revision = field[2].trim();
          continue;
        }
        // Four spaces: a gem; six: one of its dependencies.
        const spec = /^ {4}(?! )(\S+) \(([^)]+)\)\s*$/.exec(line);
        if (inSpecs && spec) {
          // `1.15.4-x86_64-linux`: one gem built for several platforms is one version. Cut at
          // the first platform segment (a split, not an unanchored pattern: no backtracking).
          const segs = spec[2].split('-');
          const cut = segs.findIndex((s, k) => k > 0 && PLATFORM.test(s));
          const version = cut > 0 ? segs.slice(0, cut).join('-') : spec[2];
          const source = section === 'GEM' ? (remote && !/^https:\/\/rubygems\.org\/?$/.test(remote) ? remote : undefined) : section === 'PATH' ? `path:${remote ?? ''}` : remote;
          packages.push({ name: spec[1], version: section === 'GIT' && revision ? `${version}@${revision.slice(0, 7)}` : version, source });
        }
        continue;
      }
      if (section === 'DEPENDENCIES') {
        const m = /^ {2}(?! )([^\s!(]+)/.exec(line);
        if (m) direct.add(m[1]);
      }
    }
    if (!sawSection && text.trim()) throw new LockfileError(`This doesn't look like a ${fileName} file.`);
    // Several platform builds of one gem collapse into a single entry.
    const seen = new Set<string>();
    const unique = packages.filter((p) => (seen.has(`${p.name}@${p.version}`) ? false : (seen.add(`${p.name}@${p.version}`), true)));
    return { format: fileName, ecosystem: 'rubygems', packages: unique, direct, notes: [] };
  },
};
