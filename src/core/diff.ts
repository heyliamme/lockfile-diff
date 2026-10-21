import { registryUrl } from './registry';
import { cleanSource } from './text';
import type { Bump, Change, ChangeKind, Counts, Ecosystem, LockedPackage, ParsedLock } from './types';
import { classify, compareVersions, parseVersion } from './version';

type Versions = Map<string, LockedPackage>;

/** name -> version -> package. Duplicates of one name@version (npm nesting) collapse into one. */
function index(lock: ParsedLock | undefined): Map<string, Versions> {
  const out = new Map<string, Versions>();
  if (!lock) return out;
  for (const raw of lock.packages) {
    // Never show credentials or signed URLs, and don't let a new token read as a new source.
    const p = { ...raw, source: raw.source && cleanSource(raw.source), version: raw.version.includes('://') ? cleanSource(raw.version) : raw.version };
    let vs = out.get(p.name);
    if (!vs) out.set(p.name, (vs = new Map()));
    const seen = vs.get(p.version);
    // A package is dev-only if every copy of it is, and nested only if every copy is.
    if (!seen) vs.set(p.version, p);
    else {
      if (seen.dev && !p.dev) seen.dev = false;
      if (seen.nested && !p.nested) seen.nested = false;
      seen.alias ??= p.alias;
      if (p.aliases) seen.aliases = [...new Set([...(seen.aliases ?? []), ...p.aliases])];
    }
  }
  return out;
}

const major = (v: string) => parseVersion(v)?.nums[0];

/** Every name a package is declared under: its own, its alias, its other aliases. */
const namesOf = (name: string, p?: LockedPackage) => [name, ...(p?.alias ? [p.alias] : []), ...(p?.aliases ?? [])];

/**
 * The one copy of a name installed at the top (not below another package), when exactly one
 * isn't nested. Yarn and others that don't record nesting have no answer with two copies.
 */
function topCopy(vs: Versions): string | undefined {
  const top = [...vs].filter(([, p]) => !p.nested);
  return top.length === 1 ? top[0][0] : undefined;
}

/** `sha512-…` -> `sha512-`: checksums of different kinds can't be compared (sha1 -> sha512 isn't a change). */
const checksumKind = (s: string) => /^[\w]{1,16}[-/:]/.exec(s)?.[0] ?? '';

/**
 * Pairs removed versions with added ones. Versions of the same major pair first (nearest
 * in version order); what is left pairs in order when the counts match, otherwise each
 * version of the shorter list takes the nearest one, and the rest are added or removed.
 */
function pair(removed: string[], added: string[]): { pairs: [string, string][]; removed: string[]; added: string[] } {
  const r = [...removed];
  const a = [...added];
  const pairs: [string, string][] = [];
  // Nearest in version order, read as an upgrade where it can be: a removed version takes the
  // first added one at or above it, an added version the last removed one at or below it.
  const nearest = (pool: string[], v: string, fromRemoved: boolean) =>
    fromRemoved
      ? (pool.find((m) => compareVersions(m, v) >= 0) ?? pool[pool.length - 1])
      : ([...pool].reverse().find((m) => compareVersions(m, v) <= 0) ?? pool[0]);
  const take = (fromRemoved: boolean, byMajor: boolean) => {
    const few = fromRemoved ? r : a;
    const many = fromRemoved ? a : r;
    for (const f of [...few]) {
      const pool = byMajor ? many.filter((m) => major(m) !== undefined && major(m) === major(f)) : many;
      if (!pool.length) continue;
      const best = nearest(pool, f, fromRemoved);
      many.splice(many.indexOf(best), 1);
      few.splice(few.indexOf(f), 1);
      pairs.push(fromRemoved ? [f, best] : [best, f]);
    }
  };
  take(r.length <= a.length, true);
  if (r.length && a.length) {
    if (r.length === a.length) {
      r.forEach((v, i) => pairs.push([v, a[i]]));
      r.length = a.length = 0;
    } else take(r.length < a.length, false);
  }
  pairs.sort((x, y) => compareVersions(x[0], y[0]));
  return { pairs, removed: r, added: a };
}

export function emptyCounts(): Counts {
  return { added: 0, removed: 0, upgraded: 0, downgraded: 0, changed: 0, major: 0, minor: 0, patch: 0, prerelease: 0 };
}

export function count(changes: Change[]): Counts {
  const c = emptyCounts();
  for (const ch of changes) {
    c[ch.kind]++;
    // Bump counts are for upgrades only, as the summary line reads ("12 upgraded (1 major)").
    if (ch.kind === 'upgraded' && ch.bump && ch.bump !== 'other') c[ch.bump]++;
  }
  return c;
}

const KIND_ORDER: Record<ChangeKind, number> = { upgraded: 0, downgraded: 1, added: 2, removed: 3, changed: 4 };
const BUMP_ORDER: Record<Bump, number> = { major: 0, minor: 1, patch: 2, prerelease: 3, other: 4 };

export function sortChanges(changes: Change[]): Change[] {
  return changes.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      BUMP_ORDER[a.bump ?? 'other'] - BUMP_ORDER[b.bump ?? 'other'] ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      compareVersions(a.from ?? a.to ?? '', b.from ?? b.to ?? ''),
  );
}

export interface LockDiff {
  changes: Change[];
  unchanged: number;
}

/** Compares two parsed lockfiles. Either may be missing (the file was added or deleted). */
export function diffLocks(before: ParsedLock | undefined, after: ParsedLock | undefined, ecosystem: Ecosystem): LockDiff {
  const a = index(before);
  const b = index(after);
  const changes: Change[] = [];
  let unchanged = 0;
  const isDirect = (name: string, side: 'old' | 'new', p?: LockedPackage): boolean | undefined => {
    const primary = side === 'new' ? after?.direct : before?.direct;
    const other = side === 'new' ? before?.direct : after?.direct;
    const set = primary ?? other;
    if (!set) return undefined;
    // An alias is declared under the name it's installed as.
    return !p?.nested && namesOf(name, p).some((n) => set.has(n));
  };
  const isDev = (name: string, p: LockedPackage | undefined, side: 'old' | 'new') => {
    const lock = side === 'new' ? after : before;
    // Where the lockfile records dev per package, that is the answer; the manifest's
    // devDependencies only fill in for lockfiles that don't.
    if (lock?.devKnown) return p?.dev || undefined;
    return !!(p?.dev || namesOf(name, p).some((n) => lock?.directDev?.has(n))) || undefined;
  };
  const sourceNote = (pa: LockedPackage | undefined, pb: LockedPackage | undefined) =>
    pa && pb && pa.source !== pb.source && (pa.source || pb.source) ? `source changed: ${pa.source ?? 'registry'} → ${pb.source ?? 'registry'}` : undefined;
  const link = (name: string, v?: string) => registryUrl(ecosystem, name, v);

  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const av = a.get(name) ?? new Map<string, LockedPackage>();
    const bv = b.get(name) ?? new Map<string, LockedPackage>();
    const removed: string[] = [];
    const added: string[] = [];
    const kept: string[] = [];
    for (const [v, pa] of av) {
      const pb = bv.get(v);
      if (!pb) {
        removed.push(v);
        continue;
      }
      kept.push(v);
      const sameKind = pa.integrity && pb.integrity && checksumKind(pa.integrity) === checksumKind(pb.integrity);
      const note = sourceNote(pa, pb) ?? (sameKind && pa.integrity !== pb.integrity ? 'checksum changed with the same version' : undefined);
      if (note) changes.push({ name, kind: 'changed', from: v, to: v, direct: isDirect(name, 'new', pb), dev: isDev(name, pb, 'new'), note, url: link(name, v), alias: pb.alias ?? pa.alias, aliases: pb.aliases ?? pa.aliases });
      else unchanged++;
    }
    for (const v of bv.keys()) if (!av.has(v)) added.push(v);
    // The copy at the top moved to another version (`node_modules/x` 1.0.0 -> 2.0.0), possibly
    // one that was already installed further down: that is what a direct dependency did.
    const ot = topCopy(av);
    const nt = topCopy(bv);
    const moved: [string, string] | undefined = ot && nt && ot !== nt ? [ot, nt] : undefined;
    if (!removed.length && !added.length && !moved) continue;
    if (moved) {
      if (removed.includes(moved[0])) removed.splice(removed.indexOf(moved[0]), 1);
      if (added.includes(moved[1])) added.splice(added.indexOf(moved[1]), 1);
    }
    removed.sort(compareVersions);
    added.sort(compareVersions);

    const p = av.size && bv.size ? pair(removed, added) : { pairs: [], removed, added };
    if (moved) p.pairs.unshift(moved);
    for (const [from, to] of p.pairs) {
      const m = classify(ecosystem, from, to);
      const kind: ChangeKind = m.direction > 0 ? 'upgraded' : m.direction < 0 ? 'downgraded' : 'changed';
      const stay = kept.filter((k) => k !== to);
      const notes = [sourceNote(av.get(from), bv.get(to)), stay.length ? `also at ${stay.sort(compareVersions).join(', ')}` : undefined].filter(Boolean);
      changes.push({
        name,
        kind,
        from,
        to,
        bump: kind === 'changed' ? undefined : m.bump,
        direct: isDirect(name, 'new', bv.get(to)),
        dev: isDev(name, bv.get(to), 'new'),
        note: notes.length ? notes.join('; ') : undefined,
        url: link(name, to),
        why: m.why,
        flag: m.flag,
        alias: bv.get(to)?.alias ?? av.get(from)?.alias,
        aliases: bv.get(to)?.aliases ?? av.get(from)?.aliases,
      });
    }
    for (const v of p.added) {
      const rest = av.size ? [...bv.keys()].filter((o) => o !== v) : [];
      changes.push({
        name,
        kind: 'added',
        to: v,
        direct: isDirect(name, 'new', bv.get(v)),
        dev: isDev(name, bv.get(v), 'new'),
        note: rest.length ? `another copy alongside ${rest.sort(compareVersions).join(', ')}` : undefined,
        url: link(name, v),
        alias: bv.get(v)?.alias,
        aliases: bv.get(v)?.aliases,
      });
    }
    for (const v of p.removed) {
      const rest = bv.size ? [...bv.keys()].filter((o) => o !== v) : [];
      changes.push({
        name,
        kind: 'removed',
        from: v,
        direct: isDirect(name, 'old', av.get(v)),
        dev: isDev(name, av.get(v), 'old'),
        note: rest.length ? `still at ${rest.sort(compareVersions).join(', ')}` : undefined,
        url: link(name),
        alias: av.get(v)?.alias,
        aliases: av.get(v)?.aliases,
      });
    }
  }
  if (ecosystem === 'go') noteMajorPaths(changes);
  return { changes: sortChanges(changes), unchanged };
}

/** Go: `example.com/m/v2` added while `example.com/m` went away is a major upgrade under a new module path. */
function noteMajorPaths(changes: Change[]) {
  const removed = new Map(changes.filter((c) => c.kind === 'removed').map((c) => [c.name, c]));
  for (const c of changes) {
    const m = c.kind === 'added' ? /^(.*)\/v(\d+)$/.exec(c.name) : null;
    if (!m) continue;
    const old = removed.get(m[1]) ?? [...removed.values()].find((r) => r.name.startsWith(`${m[1]}/v`) && r.name !== c.name);
    if (!old) continue;
    c.note = `new major version of ${old.name} (${old.from} removed)`;
    old.note = `replaced by ${c.name} ${c.to}`;
  }
}
