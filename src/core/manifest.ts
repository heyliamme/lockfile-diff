import { arr, isObj, normalizePy, obj, parseTomlText, parseYaml, str, stripBom } from './text';
import type { Ecosystem, RangeChange } from './types';
import { compareVersions, ecoVersion, parseVersion } from './version';

/** A dependency as a manifest declares it. */
export interface Declared {
  /** The range as written (`^18.2.0`, `~> 7.1`, `>=2,<3`), or what the source is (`git`, `path`). */
  range: string;
  dev: boolean;
  /** False for git, path, workspace and SDK dependencies: no registry version to check against. */
  registry: boolean;
}

export type DeclaredDeps = Map<string, Declared>;

/** Lockfile base name -> the manifest that declares what goes into it. */
export const MANIFEST_OF: Record<string, string> = {
  'package-lock.json': 'package.json',
  'npm-shrinkwrap.json': 'package.json',
  'yarn.lock': 'package.json',
  'pnpm-lock.yaml': 'package.json',
  'bun.lock': 'package.json',
  'pubspec.lock': 'pubspec.yaml',
  'Cargo.lock': 'Cargo.toml',
  'poetry.lock': 'pyproject.toml',
  'uv.lock': 'pyproject.toml',
  'composer.lock': 'composer.json',
  'Gemfile.lock': 'Gemfile',
  'gems.locked': 'gems.rb',
};

/** Manifest base name -> the lockfiles it can go with, for "the manifest changed but its lockfile didn't". */
export const LOCKS_OF: Record<string, string[]> = {};
for (const [lock, manifest] of Object.entries(MANIFEST_OF)) (LOCKS_OF[manifest] ??= []).push(lock);

const NOT_REGISTRY = /^(workspace:|file:|link:|portal:|git[+:]|github:|gitlab:|bitbucket:|https?:|\.{0,2}\/)/;

function packageJson(text: string): DeclaredDeps | undefined {
  const pkg = JSON.parse(text) as unknown;
  if (!isObj(pkg)) return undefined;
  const out: DeclaredDeps = new Map();
  for (const [k, dev] of [
    ['devDependencies', true],
    ['optionalDependencies', false],
    ['dependencies', false],
  ] as const) {
    for (const [name, raw] of Object.entries(obj(pkg[k]))) {
      const range = str(raw) ?? '';
      // An alias declares the real package's range: `npm:string-width@^4` is `^4`.
      const alias = /^npm:(?:@[^/@]+\/)?[^@]+@(.*)$/.exec(range);
      out.set(name, { range, dev, registry: !NOT_REGISTRY.test(range) && (!range.startsWith('npm:') || !!alias) });
    }
  }
  return out;
}

function pubspec(text: string): DeclaredDeps | undefined {
  const doc = parseYaml(text, 'pubspec.yaml');
  if (!isObj(doc)) return undefined;
  const out: DeclaredDeps = new Map();
  for (const [k, dev] of [
    ['dev_dependencies', true],
    ['dependencies', false],
  ] as const) {
    for (const [name, raw] of Object.entries(obj(doc[k]))) {
      if (isObj(raw)) {
        const source = ['git', 'path', 'sdk'].find((s) => s in raw);
        out.set(name, { range: source ?? str(raw.version) ?? 'any', dev, registry: !source });
      } else out.set(name, { range: str(raw) || 'any', dev, registry: true });
    }
  }
  // dependency_overrides win over what is declared.
  for (const [name, raw] of Object.entries(obj(doc.dependency_overrides))) {
    const prev = out.get(name);
    out.set(name, { range: `${isObj(raw) ? (['git', 'path', 'sdk'].find((s) => s in raw) ?? str(raw.version) ?? 'any') : str(raw) || 'any'} (override)`, dev: prev?.dev ?? false, registry: false });
  }
  return out;
}

function cargoToml(text: string): DeclaredDeps | undefined {
  const doc = parseTomlText(text, 'Cargo.toml');
  const out: DeclaredDeps = new Map();
  const workspace = obj(obj(doc.workspace).dependencies);
  const add = (table: unknown, dev: boolean) => {
    for (const [key, raw] of Object.entries(obj(table))) {
      const t = isObj(raw) ? raw : { version: raw };
      // `foo = { package = "bar" }` renames: the crate in Cargo.lock is bar.
      const name = str(t.package) ?? key;
      const inherited = t.workspace === true ? obj(workspace[key]) : undefined;
      const from = inherited ? { ...inherited, ...t } : t;
      const source = ['git', 'path'].find((s) => s in from);
      const prev = out.get(name);
      if (prev && !prev.dev) continue; // a normal dependency wins over a dev one of the same crate
      out.set(name, { range: source ?? str(from.version) ?? '*', dev, registry: !source });
    }
  };
  add(doc['dev-dependencies'], true);
  add(doc.dependencies, false);
  add(doc['build-dependencies'], false);
  for (const t of Object.values(obj(doc.target))) {
    add(obj(t)['dev-dependencies'], true);
    add(obj(t).dependencies, false);
    add(obj(t)['build-dependencies'], false);
  }
  // A virtual workspace root declares its shared versions here.
  if (!out.size) add(workspace, false);
  return out;
}

/** Longer than any real requirement or range: not worth reading (and never worth a slow regex). */
const MAX_SPEC = 1024;

/**
 * `requests[socks] >=2.0 ; python_version < "3.8"` -> [`requests`, `>=2.0`]. Read by
 * slicing, not one big pattern: a manifest is untrusted input on the extension host.
 */
function pep508(req: string): [string, string] | undefined {
  if (req.length > MAX_SPEC) return undefined;
  const semi = req.indexOf(';');
  const spec = (semi >= 0 ? req.slice(0, semi) : req).trim();
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(spec)?.[0];
  if (!name) return undefined;
  let rest = spec.slice(name.length).trim();
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) return undefined;
    rest = rest.slice(close + 1).trim();
  }
  // `name @ https://…`: a URL, not a range.
  const at = rest.indexOf('@');
  if (at >= 0) return [normalizePy(name), rest.slice(at).trim()];
  if (rest.startsWith('(') && rest.endsWith(')')) rest = rest.slice(1, -1).trim();
  return [normalizePy(name), rest || '*'];
}

function pyproject(text: string): DeclaredDeps | undefined {
  const doc = parseTomlText(text, 'pyproject.toml');
  const out: DeclaredDeps = new Map();
  const set = (name: string, range: string, dev: boolean) => {
    const prev = out.get(name);
    if (prev && !prev.dev) return;
    out.set(name, { range, dev, registry: !/^@|^(git|path|url|file)/.test(range) });
  };
  const poetryDep = (raw: unknown) => (isObj(raw) ? (['git', 'path', 'url', 'file'].find((s) => s in raw) ?? str(raw.version) ?? '*') : str(raw) ?? '*');
  const poetry = obj(obj(doc.tool).poetry);
  for (const [n, raw] of Object.entries(obj(poetry['dev-dependencies']))) set(normalizePy(n), poetryDep(raw), true);
  for (const [group, g] of Object.entries(obj(poetry.group))) for (const [n, raw] of Object.entries(obj(obj(g).dependencies))) set(normalizePy(n), poetryDep(raw), group !== 'main');
  for (const list of Object.values(obj(doc['dependency-groups']))) for (const r of arr(list)) if (typeof r === 'string') (([n, v]) => set(n, v, true))(pep508(r) ?? ['', '']);
  for (const [n, raw] of Object.entries(obj(poetry.dependencies))) if (n.toLowerCase() !== 'python') set(normalizePy(n), poetryDep(raw), false);
  const project = obj(doc.project);
  for (const list of Object.values(obj(project['optional-dependencies']))) for (const r of arr(list)) if (typeof r === 'string') (([n, v]) => set(n, v, false))(pep508(r) ?? ['', '']);
  for (const r of arr(project.dependencies)) if (typeof r === 'string') (([n, v]) => set(n, v, false))(pep508(r) ?? ['', '']);
  out.delete('');
  return out;
}

const PLATFORM = (n: string) => n === 'php' || /^(ext|lib)-/.test(n) || n === 'composer-plugin-api' || n === 'composer-runtime-api';

function composerJson(text: string): DeclaredDeps | undefined {
  const doc = JSON.parse(text) as unknown;
  if (!isObj(doc)) return undefined;
  const out: DeclaredDeps = new Map();
  for (const [k, dev] of [
    ['require-dev', true],
    ['require', false],
  ] as const) {
    for (const [name, raw] of Object.entries(obj(doc[k]))) {
      if (PLATFORM(name)) continue;
      const range = str(raw) ?? '*';
      out.set(name.toLowerCase(), { range, dev, registry: !/(^|\s)dev-|@dev\b/.test(range) });
    }
  }
  return out;
}

/** Gemfile / gems.rb: `gem "rails", "~> 7.1", ">= 7.1.2"`, with `group :development, :test do` blocks. */
function gemfile(text: string): DeclaredDeps {
  const out: DeclaredDeps = new Map();
  const groups: boolean[] = [];
  const inherit = () => groups[groups.length - 1] ?? false;
  for (const raw of text.split(/\r?\n/)) {
    // No real Gemfile line is this long; skipping it keeps every pattern below cheap.
    if (raw.length > MAX_SPEC) continue;
    const hash = raw.search(/(^|\s)#/);
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (!line) continue;
    if (/^group\s/.test(line)) {
      const doAt = line.search(/\sdo\b/);
      if (doAt >= 0) {
        const args = line.slice('group'.length, doAt);
        groups.push(/:(development|test)\b/.test(args) && !/:(default|production)\b/.test(args));
        continue;
      }
    }
    if (/\bdo\s*(\|[^|]*\|)?$/.test(line)) {
      groups.push(inherit());
      continue;
    }
    // Conditionals and loops have an `end` of their own (`if ENV["CI"]`, not `gem "x" if …`).
    if (/^(if|unless|case|while|until|begin|for)\b/.test(line) && !/\bend$/.test(line)) {
      groups.push(inherit());
      continue;
    }
    if (line === 'end') {
      groups.pop();
      continue;
    }
    const m = /^gem(?:\s*\(|\s|(?=["']))\s*["']([^"']+)["']\s*(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[2];
    // The version requirements are the string arguments before the first keyword option.
    const leading: string[] = [];
    for (const part of rest.split(',').slice(1)) {
      const s = /^\s*["']([^"']+)["']\s*\)?\s*$/.exec(part);
      if (!s) break;
      leading.push(s[1]);
    }
    const source = /\b(git|github|path):/.exec(rest)?.[1];
    const dev = groups.some(Boolean) || /\bgroups?:\s*(?:\[\s*)?:(development|test)\b/.test(rest);
    out.set(m[1], { range: source ?? (leading.length ? leading.join(', ') : '>= 0'), dev, registry: !source });
  }
  return out;
}

/** The dependencies a manifest declares, or undefined when it can't be read. */
export function readManifest(fileName: string, text: string | undefined): DeclaredDeps | undefined {
  if (text === undefined) return undefined;
  const t = stripBom(text);
  try {
    switch (fileName) {
      case 'package.json':
        return packageJson(t);
      case 'pubspec.yaml':
        return pubspec(t);
      case 'Cargo.toml':
        return cargoToml(t);
      case 'pyproject.toml':
        return pyproject(t);
      case 'composer.json':
        return composerJson(t);
      case 'Gemfile':
      case 'gems.rb':
        return gemfile(t);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Dependencies whose declared range changed, was added or was removed. */
export function diffManifest(a: DeclaredDeps | undefined, b: DeclaredDeps | undefined): RangeChange[] {
  const out: RangeChange[] = [];
  const before = a ?? new Map<string, Declared>();
  const after = b ?? new Map<string, Declared>();
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const x = before.get(name);
    const y = after.get(name);
    if (x?.range === y?.range) continue;
    out.push({ name, from: x?.range, to: y?.range, dev: (y ?? x)!.dev || undefined });
  }
  return out.sort((p, q) => (p.name < q.name ? -1 : p.name > q.name ? 1 : 0));
}

// --- ranges ------------------------------------------------------------------------

/** `out`: outside [v, hi), for PEP 440's `!=1.5.*`. */
type Cmp = { op: '<' | '<=' | '>' | '>=' | '=' | '!='; v: string } | { op: 'out'; v: string; hi: string };

/** `1.2` with `n` numbers kept and the next one bumped: upper bounds of caret and tilde ranges. */
function bumpAt(nums: number[], i: number): string {
  const out = nums.slice(0, i + 1);
  while (out.length <= i) out.push(0);
  out[i]++;
  return out.join('.');
}

/** Caret: up to (not including) the next breaking version, with semver's 0.x rules. */
function caret(v: string, zeroPatch = true): Cmp[] | undefined {
  const p = parseVersion(v);
  if (!p) return undefined;
  const given = v.replace(/^[v=]/, '').split(/[-+]/)[0].split('.').filter((x) => /^\d+$/.test(x)).length;
  const nums = p.nums;
  let i = nums.findIndex((n) => n !== 0);
  if (i < 0 || i >= given) i = Math.max(0, Math.min(given, 3) - 1); // ^0, ^0.0, ^0.0.0
  if (!zeroPatch && i > 1) i = 1; // pub: 0.0.x moves within 0.0
  return [
    { op: '>=', v },
    { op: '<', v: `${bumpAt(nums, i)}-0` },
  ];
}

/** npm and Cargo tilde: `~1.2.3` < 1.3, `~1.2` < 1.3, `~1` < 2. */
function tilde(v: string): Cmp[] | undefined {
  const p = parseVersion(v);
  if (!p) return undefined;
  const given = v.split(/[-+]/)[0].split('.').length;
  return [
    { op: '>=', v },
    { op: '<', v: `${bumpAt(p.nums, given >= 2 ? 1 : 0)}-0` },
  ];
}

/** Pessimistic (`~>` in RubyGems, `~=` in PEP 440, `~` in Composer): the last given number may grow. */
function pessimistic(v: string): Cmp[] | undefined {
  const p = parseVersion(v);
  if (!p) return undefined;
  const given = v.split(/[-+]/)[0].split('.').length;
  return [
    { op: '>=', v },
    { op: '<', v: `${bumpAt(p.nums, Math.max(0, given - 2))}-0` },
  ];
}

/** `1.2.x`, `1.*`, `1`: everything starting with the given numbers. */
function wildcard(v: string): Cmp[] | undefined {
  const nums = v.replace(/^[v=]/, '').split('.');
  const fixed: number[] = [];
  for (const n of nums) {
    if (/^[x*X]$/.test(n)) break;
    if (!/^\d+$/.test(n)) return undefined;
    fixed.push(Number(n));
  }
  if (!fixed.length) return [];
  if (fixed.length >= 3 && nums.length >= 3 && !/[x*X]/.test(v)) return [{ op: '=', v }];
  return [
    { op: '>=', v: fixed.join('.') },
    { op: '<', v: `${bumpAt(fixed, fixed.length - 1)}-0` },
  ];
}

const isPre = (v: string) => (parseVersion(v)?.pre.length ?? 0) > 0;

function test(c: Cmp, v: string): boolean {
  if (c.op === 'out') return compareVersions(v, c.v) < 0 || compareVersions(v, c.hi) >= 0;
  const d = compareVersions(v, c.v);
  switch (c.op) {
    case '<':
      return d < 0;
    case '<=':
      return d <= 0;
    case '>':
      return d > 0;
    case '>=':
      return d >= 0;
    case '=':
      return d === 0;
    case '!=':
      return d !== 0;
  }
}

/**
 * The numbers of a partial version (`1.2`, `1.x`, `1.2.*`), or undefined for a full one or
 * one with a pre-release. Empty for a bare `*`.
 */
function partial(v: string, wild: boolean): number[] | undefined {
  const nums: number[] = [];
  for (const n of v.replace(/^[v=]/, '').split('.')) {
    if (/^[x*X]$/.test(n)) return nums;
    if (!/^\d+$/.test(n)) return undefined;
    nums.push(Number(n));
  }
  return !wild && nums.length < 3 ? nums : undefined;
}

/**
 * An operator applied to a partial version, as npm and Cargo read it: `>=1.x` is >=1.0.0,
 * `>1.2` is >=1.3.0, `<=1.2` is <1.3.0, `<1.x` is <1.0.0, `^1.2.x` is ^1.2.
 */
function partialRange(eco: Ecosystem, op: string, fixed: number[]): Cmp[] | undefined {
  const base = fixed.join('.');
  const next = fixed.length ? `${bumpAt(fixed, fixed.length - 1)}-0` : undefined;
  switch (op) {
    case '^':
      return fixed.length ? caret(base, eco !== 'pub') : [];
    case '~':
      return !fixed.length ? [] : eco === 'packagist' ? undefined : tilde(base);
    case '>=':
      return fixed.length ? [{ op: '>=', v: base }] : [];
    case '<=':
      return next ? [{ op: '<', v: next }] : [];
    case '>':
      return next ? [{ op: '>=', v: next.slice(0, -2) }] : undefined;
    case '<':
      return fixed.length ? [{ op: '<', v: `${base}-0` }] : undefined;
  }
  return undefined;
}

/** One comparator as written, in the dialect of an ecosystem. */
function comparator(eco: Ecosystem, s: string): Cmp[] | undefined {
  const t = s.trim();
  if (!t || t === '*' || t === 'any' || t === 'latest' || t === 'x') return [];
  const m = /^(~>|~=|===|==|!=|>=|<=|\^|~|>|<|=)?\s*v?([\w.*+!-]+)$/.exec(t);
  if (!m) return undefined;
  const [, op = '', raw] = m;
  const v = eco === 'packagist' ? ecoVersion(eco, raw) : raw;
  const wild = /[*xX]$|[*xX]\./.test(v);
  if (op === '!=') {
    if (!wild) return [{ op, v }];
    // PEP 440 `!=1.5.*`: anything outside the 1.5 series.
    const w = wildcard(v);
    return w?.length === 2 ? [{ op: 'out', v: w[0].v, hi: w[1].v }] : undefined;
  }
  // npm and Cargo read a partial version with an operator as a range; elsewhere `<=1.2` is literal.
  const fixed = partial(v, wild);
  if (fixed && (wild || ((eco === 'npm' || eco === 'cargo') && op && op !== '~>' && op !== '~=' && op !== '==='))) {
    if (op === '' || op === '=' || op === '==') return wildcard(v);
    return partialRange(eco, op, fixed);
  }
  if (wild) return undefined;
  switch (op) {
    case '^':
      return caret(v, eco !== 'pub');
    case '~':
      return eco === 'packagist' ? pessimistic(v) : tilde(v);
    case '~>':
    case '~=':
      return pessimistic(v);
    case '>':
    case '<':
    case '>=':
    case '<=':
    case '!=':
      return [{ op, v }];
    case '=':
    case '==':
    case '===':
      return [{ op: '=', v }];
    default:
      // A bare version: caret in Cargo, exact elsewhere; `1.2` in npm means 1.2.x.
      if (eco === 'cargo') return caret(v);
      if (eco === 'npm' && v.split('.').length < 3) return wildcard(v);
      if (eco === 'packagist' && v.split('.').length < 3) return wildcard(v);
      return [{ op: '=', v }];
  }
}

/**
 * Whether `version` satisfies a declared range, as far as can be told: undefined for
 * ranges this doesn't read (tags, git refs, unusual syntax), so nothing is claimed.
 */
export function satisfies(eco: Ecosystem, range: string, version: string): boolean | undefined {
  if (range.length > MAX_SPEC / 4) return undefined; // real ranges are short
  let r = range.trim();
  const alias = /^npm:(?:@[^/@]+\/)?[^@]+@(.*)$/.exec(r);
  if (alias) r = alias[1];
  const v = ecoVersion(eco, version.replace(/@[0-9a-f]{7,}$/, ''));
  if (!parseVersion(v)) return undefined;
  if (eco === 'packagist') r = r.replace(/@(stable|RC|beta|alpha|dev)\b/gi, '');
  // Alternatives: `||` (Composer also takes a single `|`).
  const alternatives = eco === 'packagist' ? r.replace(/\|\|/g, '|').split('|') : r.split('||');
  let known = true;
  for (const alt of alternatives) {
    // npm hyphen ranges: `1.2.3 - 2.3.4`.
    const hy = /^(\S+)\s+-\s+(\S+)$/.exec(alt.trim());
    let cmps: Cmp[] | undefined = [];
    if (hy) cmps = [{ op: '>=', v: hy[1] }, ...(wildcard(hy[2])?.slice(-1).map((c): Cmp => (c.op === '=' ? { op: '<=', v: c.v } : c)) ?? [])];
    else {
      // Commas join comparators in Cargo, PEP 440, RubyGems and Composer; spaces in npm, pub and Composer.
      const parts = alt
        .split(eco === 'npm' || eco === 'pub' ? /\s+(?![\d*xX])|,/ : /\s*,\s*|\s+(?=[<>=!^~])/)
        .map((x) => x.trim())
        .filter(Boolean);
      for (const p of parts) {
        const c = comparator(eco, p);
        if (!c) {
          cmps = undefined;
          break;
        }
        cmps.push(...c);
      }
    }
    if (!cmps) {
      known = false;
      continue;
    }
    // npm and Cargo: a pre-release only matches a range that names a pre-release of the same version.
    const preOk = !isPre(v) || eco === 'pypi' || eco === 'rubygems' || cmps.some((c) => isPre(c.v) && parseVersion(c.v)!.nums.join('.') === parseVersion(v)!.nums.join('.'));
    if (cmps.every((c) => test(c, v)) && (preOk || !(eco === 'npm' || eco === 'cargo'))) return true;
  }
  return known ? false : undefined;
}
