import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const c = require('../dist/core.js');

export const F = (p) => readFileSync(new URL(`./fixtures/${p}`, import.meta.url), 'utf8');

/** Compares two texts of one lockfile; siblings are given per side. */
export function run(file, before, after, sa = {}, sb = {}) {
  return c.analyze(file, { text: before, label: 'before', siblings: sa }, { text: after, label: 'after', siblings: sb });
}

/** "kind bump name from -> to [D|t|?][ dev]" per change, as the tests read them. */
export function lines(d) {
  return d.changes.map(
    (x) => `${x.kind}${x.bump ? ` ${x.bump}` : ''} ${x.name} ${x.from ?? ''}->${x.to ?? ''} ${x.direct === true ? 'D' : x.direct === false ? 't' : '?'}${x.dev ? ' dev' : ''}`,
  );
}

export const summary = (d) => (d.error ? `error: ${d.error}` : c.summarize(d.counts));
