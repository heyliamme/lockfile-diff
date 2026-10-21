import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { c, lines, run, summary } from './helpers.mjs';

const require = createRequire(import.meta.url);
const m = require('../dist/model.js');
const json = (o) => JSON.stringify(o, null, 2);
const state = (o = {}) => ({ filter: 'all', directOnly: false, query: '', collapsed: new Set(), ...o });

describe('review fixes (round 3)', () => {
  it('Yarn: a merged alias + real-name entry is direct through the alias, with its range', () => {
    const classic = (v) => `# yarn lockfile v1\n\n\n"string-width-cjs@npm:string-width@^4.2.0", string-width@^4.1.0:\n  version "${v}"\n  resolved "https://registry.yarnpkg.com/string-width/-/string-width-${v}.tgz"\n`;
    const pkg = (r) => ({ 'package.json': json({ dependencies: { 'string-width-cjs': `npm:string-width@${r}`, foo: '^1.0.0' } }) });
    for (const [file, a, b] of [
      ['classic', classic('4.2.0'), classic('4.2.3')],
      [
        'berry',
        ...['4.2.0', '4.2.3'].map(
          (v) => `__metadata:\n  version: 8\n  cacheKey: 10c0\n\n"string-width-cjs@npm:string-width@npm:^4.2.0, string-width@npm:^4.1.0":\n  version: ${v}\n  resolution: "string-width@npm:${v}"\n  languageName: node\n  linkType: hard\n`,
        ),
      ],
    ]) {
      const d = run('yarn.lock', a, b, pkg('^4.2.0'), pkg('^4.2.3'));
      assert.deepEqual(lines(d), ['upgraded patch string-width 4.2.0->4.2.3 D'], file);
      assert.equal(d.changes[0].alias, undefined, file);
      assert.deepEqual(d.changes[0].range, { from: 'npm:string-width@^4.2.0', to: 'npm:string-width@^4.2.3' }, file);
      assert.ok(!d.notes.some((n) => n.startsWith('Declared ranges')), file);
    }
  });

  it('Yarn: a direct dependency moved to a version already locked for another package is an upgrade', () => {
    const before = `# yarn lockfile v1\n\n\nx@^1.0.0:\n  version "1.0.0"\n\nx@^2.0.0:\n  version "2.1.0"\n`;
    const after = `# yarn lockfile v1\n\n\nx@^2.0.0:\n  version "2.1.0"\n`;
    const pkg = (r) => ({ 'package.json': json({ dependencies: { x: r } }) });
    const d = run('yarn.lock', before, after, pkg('^1.0.0'), pkg('^2.0.0'));
    assert.deepEqual(lines(d), ['upgraded major x 1.0.0->2.1.0 D']);
    assert.equal(summary(d), '1 upgraded (1 major)');
  });

  it('npm: the top copy moving to a version that was nested is an upgrade', () => {
    const lock = (pk) => json({ lockfileVersion: 3, packages: { '': { dependencies: { x: '^2.0.0', y: '^1.0.0' } }, 'node_modules/y': { version: '1.0.0' }, ...pk } });
    const d = run('package-lock.json', lock({ 'node_modules/x': { version: '1.0.0' }, 'node_modules/y/node_modules/x': { version: '2.0.0' } }), lock({ 'node_modules/x': { version: '2.0.0' } }));
    assert.deepEqual(lines(d), ['upgraded major x 1.0.0->2.0.0 D']);
  });

  it('npm: an upgrade together with a dedupe reads as the upgrade', () => {
    const lock = (pk) => json({ lockfileVersion: 3, packages: { '': { dependencies: { x: '^1.0.0', y: '^1.0.0' } }, 'node_modules/y': { version: '1.0.0' }, ...pk } });
    const d = run('package-lock.json', lock({ 'node_modules/x': { version: '1.0.0' }, 'node_modules/y/node_modules/x': { version: '1.5.0' } }), lock({ 'node_modules/x': { version: '1.3.0' } }));
    assert.deepEqual(lines(d), ['upgraded minor x 1.0.0->1.3.0 D', 'removed x 1.5.0-> t']);
  });

  it('pairing prefers an upgrade when added versions are fewer', () => {
    const lock = (vs) => `# yarn lockfile v1\n\n\n${vs.map((v) => `x@${v}:\n  version "${v}"\n`).join('\n')}`;
    const d = run('yarn.lock', lock(['1.0.0', '1.5.0']), lock(['1.3.0']));
    assert.deepEqual(lines(d), ['upgraded minor x 1.0.0->1.3.0 ?', 'removed x 1.5.0-> ?']);
  });

  it("Cargo and pub: an unchanged lockfile that still satisfies the new range isn't a warning", () => {
    const lock = `version = 3\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = ["serde"]\n\n[[package]]\nname = "serde"\nversion = "1.0.195"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`;
    const toml = (r) => ({ 'Cargo.toml': `[package]\nname = "app"\n\n[dependencies]\nserde = "${r}"\n` });
    assert.equal(run('Cargo.lock', lock, lock, toml('1.0'), toml('1.0.190')).warnings, undefined);
    // Outside the new range: still said.
    assert.match(run('Cargo.lock', lock, lock, toml('1.0'), toml('1.0.200')).warnings.join(' '), /outside the range/);

    const pub = `packages:\n  http:\n    dependency: "direct main"\n    description:\n      name: http\n      url: "https://pub.dev"\n    source: hosted\n    version: "1.2.1"\nsdks:\n  dart: ">=3.0.0 <4.0.0"\n`;
    const yaml = (r) => ({ 'pubspec.yaml': `name: app\ndependencies:\n  http: ${r}\n` });
    assert.equal(run('pubspec.lock', pub, pub, yaml('^1.1.0'), yaml('^1.2.0')).warnings, undefined);
    // npm records declared ranges: an unchanged package-lock.json is out of date.
    const nl = json({ lockfileVersion: 3, packages: { '': { dependencies: { x: '^1.0.0' } }, 'node_modules/x': { version: '1.2.0' } } });
    const pj = (r) => ({ 'package.json': json({ dependencies: { x: r } }) });
    assert.match(run('package-lock.json', nl, nl, pj('^1.0.0'), pj('^1.1.0')).warnings.join(' '), /wasn't updated/);
  });

  it('npm workspaces: a sibling declared by a plain range is not missing', () => {
    const lock = (deps, linked) =>
      json({
        lockfileVersion: 3,
        packages: {
          '': { workspaces: ['packages/*'], dependencies: deps },
          'packages/a': { name: '@my/a', version: '1.0.0' },
          ...(linked ? { 'node_modules/@my/a': { resolved: 'packages/a', link: true } } : {}),
        },
      });
    const pkg = (deps) => ({ 'package.json': json({ workspaces: ['packages/*'], dependencies: deps }) });
    const d = run('package-lock.json', lock({}, true), lock({ '@my/a': '^1.0.0' }, true), pkg({}), pkg({ '@my/a': '^1.0.0' }));
    assert.equal(d.warnings, undefined);
    assert.ok(!d.notes.some((n) => n.includes('@my/a')), d.notes.join(' | '));
  });

  it('search finds a Go commit by what the view shows', () => {
    const mod = (v) => `module example.com/app\n\ngo 1.22\n\nrequire github.com/jackc/pgservicefile ${v}\n`;
    const d = run('go.mod', mod('v0.0.0-20221227161230-091c0ba34f0a'), mod('v0.0.0-20240606120523-5a60cdf6a761'));
    const hits = (q) => m.buildRows([d], state({ query: q })).filter((r) => r.t === 'change').length;
    assert.equal(hits('5a60cdf'), 1);
    assert.equal(hits('2024-06-06'), 1);
    assert.equal(hits('pgservice'), 1);
    assert.equal(hits('9999999'), 0);
  });

  it('Copy as Markdown escapes the side labels (ref names can hold `<!--`)', () => {
    for (const range of ['main → deps/<!--x', 'main → renovate/<details>', 'main → [x](y)']) {
      const line = c.toMarkdown([], { range }).split('\n')[2];
      assert.ok(!/<!--|<details>|\[x\]\(y\)/.test(line), line);
    }
  });
});
