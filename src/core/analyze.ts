import { count, diffLocks, emptyCounts, sortChanges } from './diff';
import { registryUrl } from './registry';
import { classify, compareVersions } from './version';
import { diffManifest, MANIFEST_OF, readManifest, satisfies } from './manifest';
import { baseName, parserFor, UNSUPPORTED } from './detect';
import { LockfileError, stripBom } from './text';
import type { Change, Ecosystem, FileDiff, ParsedLock, RangeChange, Siblings } from './types';

/** One side of a comparison: the lockfile's text, or undefined when it doesn't exist there. */
export interface SideText {
  text: string | undefined;
  /** Manifests next to the lockfile at the same revision (see LockParser.siblings). */
  siblings?: Siblings;
  /** Shown in errors: "HEAD", "working tree", "main". */
  label: string;
  /** This side's file name when it differs from the other's (npm -> pnpm migration). */
  fileName?: string;
}

function parseSide(path: string, side: SideText): ParsedLock | undefined {
  if (side.text === undefined) return undefined;
  const fileName = side.fileName ?? baseName(path);
  const parser = parserFor(fileName);
  if (!parser) throw new LockfileError(UNSUPPORTED[fileName] ?? `${fileName} is not a lockfile this extension can read.`);
  // A byte order mark survives some reads (git show) and not others (editors): drop it everywhere.
  const siblings = Object.fromEntries(Object.entries(side.siblings ?? {}).map(([k, v]) => [k, v === undefined ? v : stripBom(v)]));
  try {
    return parser.parse(stripBom(side.text), { fileName, siblings });
  } catch (e) {
    const msg = e instanceof LockfileError ? e.message : `couldn't be read (${e instanceof Error ? e.message : String(e)})`;
    throw new LockfileError(`${fileName} in ${side.label}: ${msg}`);
  }
}

/** Compares one lockfile across two sides. Never throws: problems end up in `error`. */
export function analyze(path: string, before: SideText, after: SideText): FileDiff {
  const name = baseName(path);
  const parser = parserFor(after.fileName ?? before.fileName ?? path);
  const other = parserFor(before.fileName ?? path);
  if (parser && other && parser.ecosystem !== other.ecosystem) {
    return { path, changes: [], counts: emptyCounts(), unchanged: 0, directKnown: false, notes: [], format: name, ecosystem: parser.ecosystem, error: `${before.fileName ?? name} and ${after.fileName ?? name} belong to different ecosystems, so their packages can't be compared.` };
  }
  const base = { path, changes: [], counts: emptyCounts(), unchanged: 0, directKnown: false, notes: [] as string[] };
  if (!parser) {
    const n = after.fileName ?? name;
    return { ...base, format: n, ecosystem: 'npm', error: UNSUPPORTED[n] ?? `${n} is not a lockfile this extension can read.` };
  }
  try {
    const a = parseSide(path, before);
    const b = parseSide(path, after);
    if (!a && !b) return { ...base, format: name, ecosystem: parser.ecosystem, error: `${name} exists in neither ${before.label} nor ${after.label}.` };
    const { changes, unchanged } = diffLocks(a, b, parser.ecosystem);
    const notes = [...new Set([...(a?.notes ?? []), ...(b?.notes ?? [])])];
    if (!a) notes.unshift(`New in ${after.label}: every package counts as added.`);
    if (!b) notes.unshift(`Deleted in ${after.label}: every package counts as removed.`);
    if (a && b && a.format !== b.format) notes.unshift(`Format changed: ${a.format} → ${b.format}.`);
    const out: FileDiff = {
      ...base,
      format: (b ?? a)!.format,
      ecosystem: parser.ecosystem,
      changes,
      counts: count(changes),
      unchanged,
      directKnown: !!(a?.direct ?? b?.direct),
      notes,
    };
    if (before.text !== undefined && before.text === after.text) out.lockUnchanged = true;
    withManifest(out, before, after, b);
    out.counts = count(sortChanges(out.changes));
    return out;
  } catch (e) {
    return { ...base, format: name, ecosystem: parser.ecosystem, error: e instanceof Error ? e.message : String(e) };
  }
}

const namesOf = (c: Change) => [c.name, ...(c.alias ? [c.alias] : []), ...(c.aliases ?? [])];

/**
 * A direct dependency moved to a version that was already locked for something else
 * (`x@^1` 1.0.0 and `x@^2` 2.1.0, then the manifest asks for `^2`): the lockfile only lost
 * 1.0.0, but the dependency was upgraded to 2.1.0. Lockfiles that record nesting (npm) get
 * this from the diff; this reads it from the declared range for those that don't (Yarn).
 */
function movedToKept(d: FileDiff, ranges: RangeChange[], lock: ParsedLock) {
  const eco = d.ecosystem;
  for (const r of ranges) {
    if (!r.to) continue;
    const mine = d.changes.filter((c) => namesOf(c).includes(r.name));
    if (mine.some((c) => c.kind !== 'removed' && c.kind !== 'changed')) continue;
    const gone = mine.filter((c) => c.kind === 'removed' && c.direct !== false && c.from && (!r.from || satisfies(eco, r.from, c.from) !== false));
    if (gone.length !== 1) continue;
    const c = gone[0];
    const now = [...new Set(lock.packages.filter((p) => p.name === c.name && !p.nested).map((p) => p.version))].sort(compareVersions);
    const to = now.filter((v) => satisfies(eco, r.to!, v) === true).pop();
    if (!to) continue;
    const m = classify(eco, c.from!, to);
    if (!m.direction) continue;
    const rest = now.filter((v) => v !== to);
    Object.assign(c, {
      kind: m.direction > 0 ? 'upgraded' : 'downgraded',
      to,
      bump: m.bump,
      why: m.why,
      flag: m.flag,
      url: registryUrl(eco, c.name, to),
      note: rest.length ? `also at ${rest.join(', ')}` : undefined,
    });
  }
}

const MAX_LISTED = 8;
const list = (items: string[]) => (items.length > MAX_LISTED ? `${items.slice(0, MAX_LISTED).join(', ')} and ${items.length - MAX_LISTED} more` : items.join(', '));

/**
 * Declared ranges from the manifest next to the lockfile: the range change goes on the
 * package's row, and what the lockfile doesn't reflect becomes a warning.
 */
function withManifest(d: FileDiff, before: SideText, after: SideText, lock: ParsedLock | undefined) {
  const lockName = after.fileName ?? before.fileName ?? baseName(d.path);
  const mf = MANIFEST_OF[lockName];
  // Only when both sides were looked up: two loose files have no manifest to speak of.
  if (!mf || !before.siblings || !after.siblings || !(mf in before.siblings) || !(mf in after.siblings)) return;
  const ma = readManifest(mf, before.siblings[mf]);
  const mb = readManifest(mf, after.siblings[mf]);
  if (!ma && !mb) return;
  if ((before.siblings[mf] !== undefined && !ma) || (after.siblings[mf] !== undefined && !mb)) return; // unreadable: say nothing
  // Lockfiles that don't record dev dependencies (Cargo, Bundler): the manifest says which direct ones are.
  const declaredNow = mb ?? ma!;
  if (lock && !lock.devKnown && !lock.directDev?.size) {
    for (const c of d.changes) if (c.direct && c.dev === undefined && namesOf(c).some((n) => declaredNow.get(n)?.dev)) c.dev = true;
  }
  const ranges = diffManifest(ma, mb);
  const eco: Ecosystem = d.ecosystem;
  if (lock) movedToKept(d, ranges, lock);
  const byName = new Map<string, Change[]>();
  for (const c of d.changes) for (const n of namesOf(c)) byName.set(n, [...(byName.get(n) ?? []), c]);
  // Linked local packages (npm workspaces) are declared by a plain range but never locked as a version.
  const local = (name: string) => !!lock?.local?.has(name);
  // Bundler lists a gem for platforms the lock doesn't target (`platforms: %i[windows jruby]`)
  // under DEPENDENCIES with no spec: it is in the lockfile, there is just nothing to install here.
  const listedOnly = (name: string) => eco === 'rubygems' && !!lock?.direct?.has(name) && !lock.packages.some((p) => p.name === name);
  const unmatched: string[] = [];
  for (const r of ranges) {
    const hits = (byName.get(r.name) ?? []).filter((c) => c.direct !== false);
    for (const c of hits) c.range = { from: r.from, to: r.to };
    if (!hits.length && !listedOnly(r.name) && !local(r.name)) unmatched.push(`${r.name} ${r.from ?? '(new)'} → ${r.to ?? '(removed)'}`);
  }
  if (!ranges.length) return;
  d.manifest = { file: mf, ranges };
  const warnings: string[] = [];
  // Cargo.lock and pubspec.lock don't record declared requirements: one that still satisfies
  // the new range rightly stays as it is (the range check below covers one that doesn't).
  if (d.lockUnchanged && eco !== 'cargo' && eco !== 'pub') warnings.push(`${mf} changes ${ranges.length === 1 ? '1 dependency' : `${ranges.length} dependencies`}, but ${lockName} didn't change: the lockfile wasn't updated.`);
  if (lock) {
    const missing: string[] = [];
    const outside: string[] = [];
    const declared = mb ?? ma!;
    for (const r of ranges) {
      const dec = declared.get(r.name);
      if (!r.to || !dec?.registry) continue;
      const locked = lock.packages.filter((p) => p.name === r.name || p.alias === r.name || !!p.aliases?.includes(r.name)).map((p) => p.version);
      if (!locked.length) {
        if (!r.from && !listedOnly(r.name) && !local(r.name)) missing.push(r.name);
        continue;
      }
      const verdicts = locked.map((v) => satisfies(eco, r.to!, v));
      if (verdicts.some((x) => x === true) || verdicts.every((x) => x === undefined)) continue;
      outside.push(`${r.name} (${r.to}; locked ${[...new Set(locked)].join(', ')})`);
    }
    if (missing.length) warnings.push(`Declared in ${mf} but not in ${lockName}: ${list(missing)}.`);
    if (outside.length) warnings.push(`${lockName} has versions outside the range ${mf} now declares: ${list(outside)}.`);
  }
  if (unmatched.length && !d.lockUnchanged) d.notes.push(`Declared ranges that changed in ${mf} with no change in ${lockName}: ${list(unmatched)}.`);
  else if (unmatched.length) d.notes.push(`Changed in ${mf}: ${list(unmatched)}.`);
  if (warnings.length) d.warnings = warnings;
}
