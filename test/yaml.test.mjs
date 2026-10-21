import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { c, F } from './helpers.mjs';

const require = createRequire(import.meta.url);
const YAML = require('yaml');

/** The full parser's view, with nulls as '' as the fast reader keeps them. */
const reference = (t) => norm(YAML.parse(t, { schema: 'failsafe' }));
const norm = (v) => (v === null ? '' : Array.isArray(v) ? v.map(norm) : typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])) : v);

describe('fast lockfile YAML reader', () => {
  const files = [...readdirSync(new URL('./fixtures/pnpm', import.meta.url)).map((f) => `pnpm/${f}`), 'pub/old.lock', 'pub/new.lock', 'yarn/berry-old.lock', 'yarn/berry-new.lock'];
  for (const f of files) {
    it(`reads ${f} exactly as a full YAML parser does`, () => {
      const t = F(f);
      assert.deepEqual(c.parseLockYaml(t), reference(t));
    });
  }

  it('handles quoting, comments, flow values and sequences', () => {
    const t = [
      '# comment',
      "a: 'it''s'",
      'b: "tab\\there \\u00e9"',
      'c: plain value # trailing comment',
      "d: {integrity: sha512-x==, tarball: 'https://h/x.tgz', engines: {node: '>=12'}}",
      'e: [darwin, linux]',
      'f:',
      '  - one',
      '  - "two"',
      'g:',
      '- same-indent item',
      "'@scope/x@1.0.0(react@18.0.0)':",
      '  dev: true',
      'h:',
      'i: {}',
      'j: []',
      '',
    ].join('\n');
    assert.deepEqual(c.parseLockYaml(t), reference(t));
  });

  for (const [why, t] of [
    ['anchors', 'a: &x 1\nb: *x\n'],
    ['block scalars', 'a: |\n  text\n'],
    ['multi-line flow', 'a: {b: 1,\n  c: 2}\n'],
    ['tabs', 'a:\n\tb: 1\n'],
    ['mappings in sequences', 'a:\n  - b: 1\n'],
    ['odd indentation', 'a:\n    b: 1\n  c: 2\n'],
    ['several documents', 'a: 1\n---\nb: 2\n'],
  ]) {
    it(`gives up on ${why}, so the full parser takes over`, () => {
      assert.throws(() => c.parseLockYaml(t), c.Unsupported);
      // ...and parseYaml still returns what the full parser makes of it (or its error).
      try {
        c.parseYaml(t, 'x');
      } catch (e) {
        assert.ok(e instanceof c.LockfileError);
      }
    });
  }
});
