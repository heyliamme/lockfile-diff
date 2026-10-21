import { parse as parseToml } from 'smol-toml';
import { parse as parseYamlDoc } from 'yaml';
import { parseLockYaml, Unsupported } from './yaml';

/** A lockfile that can't be read. The message is shown to the user as is. */
export class LockfileError extends Error {}

function lineCol(text: string, pos: number): string {
  let line = 1;
  let last = -1;
  for (let i = text.indexOf('\n'); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) {
    line++;
    last = i;
  }
  return `line ${line}, column ${pos - last}`;
}

/**
 * Where a JSON text stops being valid. Only used after JSON.parse failed, because V8 leaves
 * the position out of some messages ("Unexpected token '}', … is not valid JSON").
 */
export function jsonErrorAt(text: string): number {
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \t\r\n'.includes(text[i])) i++;
  };
  const fail = (): never => {
    throw i;
  };
  const value = (depth: number): void => {
    if (depth > 4000) fail();
    ws();
    const ch = text[i];
    if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']';
      i++;
      ws();
      if (text[i] === close) {
        i++;
        return;
      }
      for (;;) {
        if (ch === '{') {
          ws();
          if (text[i] !== '"') fail();
          string();
          ws();
          if (text[i] !== ':') fail();
          i++;
        }
        value(depth + 1);
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === close) {
          i++;
          return;
        }
        fail();
      }
    }
    if (ch === '"') return string();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
    if (!m) fail();
    i += m![0].length;
  };
  const string = () => {
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text.charCodeAt(i) < 0x20) fail();
      i += text[i] === '\\' ? 2 : 1;
    }
    if (i >= text.length) fail();
    i++;
  };
  try {
    value(0);
    ws();
    return i < text.length ? i : -1;
  } catch (at) {
    return typeof at === 'number' ? at : -1;
  }
}

export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const pos = /position (\d+)/.exec(msg);
    const lc = /line (\d+) column (\d+)/.exec(msg);
    const at = lc || pos ? -1 : jsonErrorAt(text.replace(/^\uFEFF/, ''));
    const where = lc ? `line ${lc[1]}, column ${lc[2]}` : pos ? lineCol(text, Number(pos[1])) : at >= 0 ? lineCol(text, at) : undefined;
    throw new LockfileError(`${what} is not valid JSON${where ? ` (${where})` : ''}.`);
  }
}

/** JSON with comments and trailing commas, as in bun.lock. */
export function parseJsonc(text: string, what: string): unknown {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] !== '}' && text[j] !== ']') out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return parseJson(out, what);
}

export function parseYaml(text: string, what: string): unknown {
  try {
    return parseLockYaml(text);
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e;
  }
  // Outside the subset lockfiles use: the full parser decides (and words any error).
  try {
    return parseYamlDoc(text, { uniqueKeys: false, maxAliasCount: 1000, schema: 'failsafe', logLevel: 'error' });
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
    throw new LockfileError(`${what} is not valid YAML: ${msg}`);
  }
}

export function parseTomlText(text: string, what: string): Record<string, unknown> {
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
    throw new LockfileError(`${what} is not valid TOML: ${msg}`);
  }
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
export const obj = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** `@scope/name@1.0.0` -> [`@scope/name`, `1.0.0`]; the first `@` of a scope doesn't count. */
export function splitAt(spec: string): [string, string] {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at < 0 ? [spec, ''] : [spec.slice(0, at), spec.slice(at + 1)];
}

/** Dependency names declared in a package.json, and which of them are dev-only. */
export function packageJsonDeps(text: string | undefined): { direct: Set<string>; dev: Set<string> } | undefined {
  if (text === undefined) return undefined;
  let pkg: unknown;
  try {
    pkg = JSON.parse(stripBom(text));
  } catch {
    return undefined;
  }
  if (!isObj(pkg)) return undefined;
  const direct = new Set<string>();
  const dev = new Set<string>();
  for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies']) for (const n of Object.keys(obj(pkg[k]))) direct.add(n);
  for (const n of Object.keys(obj(pkg.devDependencies))) {
    if (!direct.has(n)) dev.add(n);
    direct.add(n);
  }
  return { direct, dev };
}

/** PEP 503: `Foo_Bar.baz` and `foo-bar-baz` are the same project. */
export const normalizePy = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

/**
 * A source or URL as it may be shown: no credentials (`//user:token@host`, `user:token@host:`),
 * no query string and no fragment, where tokens and signed parameters live.
 */
export function cleanSource(s: string): string {
  return s
    .replace(/[?#].*$/s, '')
    .replace(/^([a-z][\w+.-]*:\/\/)[^/@]*@/i, '$1')
    .replace(/^[^/@:\s]+:[^/@\s]*@(?=[^/@\s]+:)/, '');
}

/** Strips a leading byte order mark, which Git reads keep and editors drop. */
export const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
