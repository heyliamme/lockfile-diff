import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { run } from './helpers.mjs';

// 50,000 packages, a tenth of them upgraded on the new side.
const N = 50_000;
const ver = (i, bump) => `${i % 7}.${i % 13}.${(i % 11) + (bump && i % 10 === 0 ? 1 : 0)}`;
const name = (i) => (i % 5 === 0 ? `@scope${i % 97}/pkg-${i}` : `pkg-${i}`);

function npm(bump) {
  const packages = { '': { name: 'big', dependencies: { 'pkg-1': '*' } } };
  for (let i = 0; i < N; i++) packages[`node_modules/${name(i)}`] = { version: ver(i, bump), resolved: `https://registry.npmjs.org/${name(i)}/-/x.tgz`, integrity: `sha512-${i}${bump && i % 10 === 0 ? 'b' : ''}` };
  return JSON.stringify({ lockfileVersion: 3, packages }, null, 2);
}
function pnpm(bump) {
  const out = ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies:', '      pkg-1:', "        specifier: '*'", `        version: ${ver(1, bump)}`, '', 'packages:', ''];
  for (let i = 0; i < N; i++) out.push(`  '${name(i)}@${ver(i, bump)}':`, `    resolution: {integrity: sha512-${i}}`, '');
  return out.join('\n');
}
function yarnClassic(bump) {
  const out = ['# yarn lockfile v1', ''];
  for (let i = 0; i < N; i++) out.push(`"${name(i)}@^${ver(i, false)}":`, `  version "${ver(i, bump)}"`, `  resolved "https://registry.yarnpkg.com/${name(i)}/-/x.tgz#abc"`, `  integrity sha512-${i}`, '');
  return out.join('\n');
}
function cargo(bump) {
  const out = ['version = 3', ''];
  for (let i = 0; i < N; i++) out.push('[[package]]', `name = "crate-${i}"`, `version = "${ver(i, bump)}"`, 'source = "registry+https://github.com/rust-lang/crates.io-index"', `checksum = "${i.toString(16).padStart(64, '0')}"`, '');
  return out.join('\n');
}

describe('50,000-package lockfiles', () => {
  for (const [file, gen, budget] of [
    ['package-lock.json', npm, 3000],
    ['pnpm-lock.yaml', pnpm, 8000],
    ['yarn.lock', yarnClassic, 3000],
    ['Cargo.lock', cargo, 8000],
  ]) {
    it(`${file} compares in well under a few seconds`, () => {
      const a = gen(false);
      const b = gen(true);
      const t = performance.now();
      const d = run(file, a, b);
      const ms = performance.now() - t;
      assert.equal(d.error, undefined);
      assert.equal(d.counts.upgraded, N / 10);
      assert.equal(d.unchanged, N - N / 10);
      assert.ok(ms < budget, `${file}: ${Math.round(ms)} ms (${(a.length / 1e6).toFixed(1)} MB a side)`);
      console.log(`    ${file}: ${Math.round(ms)} ms for 2 × ${(a.length / 1e6).toFixed(1)} MB`);
    });
  }
});
