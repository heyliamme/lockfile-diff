/**
 * A fast reader for the YAML that lockfiles are written in: block mappings by indentation,
 * plain and quoted scalars, one-line flow mappings and sequences, simple block sequences.
 * Every scalar stays a string. Anything outside that subset (anchors, block scalars,
 * multi-line flow, tabs) throws `Unsupported`, and the caller falls back to a full parser.
 *
 * About 20 times faster than a general YAML parser on a large pnpm-lock.yaml.
 */
export class Unsupported extends Error {}

type Node = Record<string, unknown> | unknown[];

const unsupported = (line: number, why: string): never => {
  throw new Unsupported(`line ${line + 1}: ${why}`);
};

function doubleQuoted(s: string, line: number): string {
  try {
    return JSON.parse(s.replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1').replace(/\\\//g, '/'));
  } catch {
    return unsupported(line, 'escape in a double-quoted string');
  }
}

/** Reads a quoted scalar at s[i]; returns the value and the index after it. */
function quoted(s: string, i: number, line: number): [string, number] {
  const q = s[i];
  let j = i + 1;
  if (q === "'") {
    for (;;) {
      j = s.indexOf("'", j);
      if (j < 0) unsupported(line, 'unterminated string');
      if (s[j + 1] === "'") j += 2;
      else break;
    }
    return [s.slice(i + 1, j).replace(/''/g, "'"), j + 1];
  }
  while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
  if (j >= s.length) unsupported(line, 'unterminated string');
  return [doubleQuoted(s.slice(i, j + 1), line), j + 1];
}

/** A plain scalar ends at ` #` (a comment); trailing spaces aren't part of it. */
function plain(s: string, line: number): string {
  const hash = s.indexOf(' #');
  const v = (hash >= 0 ? s.slice(0, hash) : s).trimEnd();
  if (/^[&*!|>%@`]/.test(v)) unsupported(line, `"${v[0]}" at the start of a value`);
  return v;
}

/** `{a: b, c: [d, e]}` or `[a, b]` on one line. */
function flow(s: string, line: number): [unknown, number] {
  let i = 0;
  const ws = () => {
    while (s[i] === ' ') i++;
  };
  const scalar = (stops: string): string => {
    ws();
    if (s[i] === '"' || s[i] === "'") {
      const [v, j] = quoted(s, i, line);
      i = j;
      return v;
    }
    let j = i;
    while (j < s.length && !stops.includes(s[j]) && !(s[j] === ':' && (s[j + 1] === ' ' || stops.includes(s[j + 1] ?? '')))) j++;
    const v = s.slice(i, j).trim();
    i = j;
    return v;
  };
  const value = (): unknown => {
    ws();
    if (s[i] === '{') {
      i++;
      const o: Record<string, unknown> = {};
      ws();
      if (s[i] === '}') {
        i++;
        return o;
      }
      for (;;) {
        const k = scalar(',}');
        ws();
        if (s[i] !== ':') unsupported(line, 'flow mapping without ":"');
        i++;
        o[k] = value();
        ws();
        if (s[i] === ',') {
          i++;
          continue;
        }
        if (s[i] === '}') {
          i++;
          return o;
        }
        return unsupported(line, 'unterminated flow mapping');
      }
    }
    if (s[i] === '[') {
      i++;
      const a: unknown[] = [];
      ws();
      if (s[i] === ']') {
        i++;
        return a;
      }
      for (;;) {
        a.push(value());
        ws();
        if (s[i] === ',') {
          i++;
          continue;
        }
        if (s[i] === ']') {
          i++;
          return a;
        }
        return unsupported(line, 'unterminated flow sequence');
      }
    }
    return scalar(',}]');
  };
  const v = value();
  return [v, i];
}

function scalarValue(rest: string, line: number): unknown {
  const c = rest[0];
  if (c === '{' || c === '[') {
    const [v, end] = flow(rest, line);
    const tail = rest.slice(end).trim();
    if (tail && !tail.startsWith('#')) unsupported(line, 'text after a flow value');
    return v;
  }
  if (c === '"' || c === "'") {
    const [v, end] = quoted(rest, 0, line);
    const tail = rest.slice(end).trim();
    if (tail && !tail.startsWith('#')) unsupported(line, 'text after a quoted value');
    return v;
  }
  return plain(rest, line);
}

/** Splits `key: value` (key plain or quoted). Returns undefined for a line that isn't one. */
function keyValue(content: string, line: number): [string, string] | undefined {
  let key: string;
  let rest: string;
  if (content[0] === '"' || content[0] === "'") {
    const [k, end] = quoted(content, 0, line);
    if (content[end] !== ':') return undefined;
    key = k;
    rest = content.slice(end + 1);
  } else {
    const at = content.indexOf(': ');
    if (at >= 0) {
      key = content.slice(0, at);
      rest = content.slice(at + 2);
    } else if (content.endsWith(':')) {
      key = content.slice(0, -1);
      rest = '';
    } else return undefined;
    if (key.startsWith('? ') || /^[&*!|>%@`]/.test(key)) unsupported(line, 'complex key');
    key = key.trimEnd();
  }
  return [key, rest.trim()];
}

export function parseLockYaml(text: string): unknown {
  const lines = text.split('\n');
  const root: Record<string, unknown> = {};
  // Containers by indentation. `pending` is a key whose value starts on the next lines.
  const stack: { indent: number; node: Node }[] = [{ indent: -1, node: root }];
  let pending: { parent: Record<string, unknown>; key: string; indent: number } | undefined;

  for (let n = 0; n < lines.length; n++) {
    let raw = lines[n];
    if (raw.endsWith('\r')) raw = raw.slice(0, -1);
    let indent = 0;
    while (raw.charCodeAt(indent) === 32) indent++;
    const content = raw.slice(indent);
    if (!content || content[0] === '#') continue;
    if (content[0] === '\t') unsupported(n, 'tab indentation');
    if (indent === 0 && (content === '---' || content.startsWith('%'))) {
      if (content.startsWith('%') || Object.keys(root).length) unsupported(n, 'more than one document');
      continue;
    }
    const isItem = content === '-' || content.startsWith('- ');

    if (pending) {
      // The pending key's value: a nested mapping (deeper) or a sequence (deeper, or "- " at the same indent).
      if (indent > pending.indent || (isItem && indent === pending.indent)) {
        const node: Node = isItem ? [] : {};
        pending.parent[pending.key] = node;
        stack.push({ indent, node });
      } else pending.parent[pending.key] = isItem ? [] : ''; // `key:` with nothing under it is null; keep it falsy
      pending = undefined;
    }
    // Close deeper containers, and a "- " sequence at its key's own indent when a key follows.
    while (stack.length > 1) {
      const t = stack[stack.length - 1];
      if (indent < t.indent || (indent === t.indent && !isItem && Array.isArray(t.node))) stack.pop();
      else break;
    }
    const top = stack[stack.length - 1];
    if (indent !== top.indent && top.indent !== -1) unsupported(n, 'unexpected indentation');
    if (top.indent === -1 && indent !== 0) unsupported(n, 'indented first line');

    if (isItem) {
      if (!Array.isArray(top.node)) unsupported(n, 'sequence item inside a mapping');
      const rest = content.slice(1).trim();
      if (!rest || keyValue(rest, n)) unsupported(n, 'mapping inside a sequence');
      (top.node as unknown[]).push(scalarValue(rest, n));
      continue;
    }
    if (Array.isArray(top.node)) unsupported(n, 'mapping key inside a sequence');
    const kv = keyValue(content, n);
    if (!kv) unsupported(n, 'not a "key: value" line');
    const [key, rest] = kv!;
    const parent = top.node as Record<string, unknown>;
    if (!rest || rest[0] === '#') pending = { parent, key, indent };
    else parent[key] = scalarValue(rest, n);
  }
  if (pending) pending.parent[pending.key] = '';
  return root;
}
