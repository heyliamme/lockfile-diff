import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { c, lines, run } from './helpers.mjs';

const json = (o) => JSON.stringify(o, null, 2);
const ms = (fn) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe('review fixes (round 2): parsers', () => {
  it('pnpm: a git dependency fetched as a codeload tarball changes by commit', () => {
    const lock = (sha) =>
      `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      is-plain-obj:\n        specifier: github:sindresorhus/is-plain-obj\n        version: https://codeload.github.com/sindresorhus/is-plain-obj/tar.gz/${sha}\npackages:\n  is-plain-obj@https://codeload.github.com/sindresorhus/is-plain-obj/tar.gz/${sha}:\n    resolution: {tarball: https://codeload.github.com/sindresorhus/is-plain-obj/tar.gz/${sha}}\n    version: 4.1.0\nsnapshots:\n  is-plain-obj@https://codeload.github.com/sindresorhus/is-plain-obj/tar.gz/${sha}: {}\n`;
    const d = run('pnpm-lock.yaml', lock('d41fca4d9299dd7bc84adff25ef3fc8529751e5b'), lock('3b33a59bd31fdee17acebeb0f9e39b6eca007719'));
    assert.deepEqual(lines(d), ['changed is-plain-obj 4.1.0@d41fca4->4.1.0@3b33a59 D']);
  });

  it('bun: a nested copy of a direct dependency is transitive', () => {
    const lock = (v) =>
      json({
        lockfileVersion: 1,
        workspaces: { '': { name: 'app', dependencies: { debug: '^4.3.4', send: '^0.18.0' } } },
        packages: { debug: ['debug@4.3.4', '', {}, 'sha512-a'], send: ['send@0.18.0', '', {}, 'sha512-b'], 'send/debug': [`debug@${v}`, '', {}, `sha512-${v}`] },
      });
    const d = run('bun.lock', lock('2.6.9'), lock('2.6.8'));
    assert.deepEqual(lines(d), ['downgraded patch debug 2.6.9->2.6.8 t']);
  });

  it('pnpm: only the version an importer names is direct', () => {
    const lock = (v) =>
      `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      debug:\n        specifier: ^4.3.4\n        version: 4.3.4\npackages:\n  debug@4.3.4: {}\n  debug@${v}: {}\nsnapshots:\n  debug@4.3.4: {}\n  debug@${v}: {}\n`;
    const d = run('pnpm-lock.yaml', lock('2.6.9'), lock('2.6.8'));
    assert.deepEqual(lines(d), ['downgraded patch debug 2.6.9->2.6.8 t']);
  });

  it('Cargo: a root naming `syn 2.0.50` makes other syn versions transitive, and they take no dev flag', () => {
    const lock = (v) =>
      `version = 3\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = ["syn 2.0.50", "foo"]\n\n[[package]]\nname = "foo"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\ndependencies = ["syn 1.0.107"]\n\n[[package]]\nname = "syn"\nversion = "${v}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n\n[[package]]\nname = "syn"\nversion = "2.0.50"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`;
    const toml = '[package]\nname = "app"\n\n[dependencies]\nfoo = "1"\n\n[dev-dependencies]\nsyn = "2"\n';
    const d = run('Cargo.lock', lock('1.0.107'), lock('1.0.109'), { 'Cargo.toml': toml }, { 'Cargo.toml': toml });
    assert.deepEqual(lines(d), ['upgraded patch syn 1.0.107->1.0.109 t']);
  });

  it("npm: devOptional isn't dev (--omit=dev still installs it)", () => {
    const lock = (v) => json({ lockfileVersion: 3, packages: { '': { dependencies: { next: '^14' }, devDependencies: { typescript: '^5' } }, 'node_modules/next': { version: '14.0.0' }, 'node_modules/typescript': { version: v, devOptional: true } } });
    const d = run('package-lock.json', lock('5.3.2'), lock('5.4.0'));
    assert.deepEqual(lines(d), ['upgraded minor typescript 5.3.2->5.4.0 D']);
  });

  it('Yarn: a merged key with the real name first-class is not labelled with the -cjs alias', () => {
    const classic = (v) => `# yarn lockfile v1\n\n\n"string-width-cjs@npm:string-width@^4.2.0", string-width@^4.1.0:\n  version "${v}"\n  resolved "https://registry.yarnpkg.com/string-width/-/string-width-${v}.tgz"\n`;
    const pkg = { 'package.json': json({ dependencies: { 'string-width': '^4.1.0' } }) };
    const a = run('yarn.lock', classic('4.2.2'), classic('4.2.3'), pkg, pkg);
    assert.equal(a.changes[0].alias, undefined);
    const berry = (v) => `__metadata:\n  version: 8\n  cacheKey: 10c0\n\n"string-width-cjs@npm:string-width@npm:^4.2.0, string-width@npm:^4.1.0":\n  version: ${v}\n  resolution: "string-width@npm:${v}"\n  languageName: node\n  linkType: hard\n`;
    const b = run('yarn.lock', berry('4.2.2'), berry('4.2.3'), pkg, pkg);
    assert.equal(b.changes[0].alias, undefined);
    // Only the alias asked for: still the alias.
    const only = (v) => `__metadata:\n  version: 8\n  cacheKey: 10c0\n\n"cjs@npm:string-width@npm:^4.2.0":\n  version: ${v}\n  resolution: "string-width@npm:${v}"\n  languageName: node\n  linkType: hard\n`;
    assert.equal(run('yarn.lock', only('4.2.2'), only('4.2.3'), pkg, pkg).changes[0].alias, 'cjs');
  });

  it("Composer: -p1 is a patch release above the plain version", () => {
    assert.deepEqual(c.classify('packagist', '2.4.6', '2.4.6-p1'), { direction: 1, bump: 'patch' });
    assert.equal(c.classify('packagist', '2.4.6-p2', '2.4.6-p1').direction, -1);
    assert.equal(c.satisfies('packagist', '^103.0.6', '103.0.6-p1'), true);
  });
});

describe('review fixes (round 2): manifests and ranges', () => {
  it('partial versions and wildcards keep their operator', () => {
    for (const [eco, range, v, want] of [
      ['npm', '>=16.x', '20.1.0', true],
      ['npm', '^1.2.x', '1.9.0', true],
      ['npm', '~1.2.x', '1.3.0', false],
      ['npm', '<2.x', '1.5.0', true],
      ['npm', '<=1.2', '1.2.5', true],
      ['npm', '>=1 <=2', '2.5.0', true],
      ['npm', '>1.x', '1.5.0', false],
      ['npm', '>1.2', '1.3.0', true],
      ['cargo', '<= 1.2', '1.2.4', true],
      ['pypi', '<=1.2', '1.2.5', false],
      ['pypi', '>=1.0,!=1.5.*', '1.5.2', false],
      ['pypi', '>=1.0,!=1.5.*', '1.6.0', true],
    ]) {
      assert.equal(c.satisfies(eco, range, v), want, `${eco} ${range} ${v}`);
    }
  });

  it('Gemfile: an if block inside a group keeps the group dev', () => {
    const m = c.readManifest('Gemfile', 'group :development, :test do\n  if ENV["WITH_PRY"]\n    gem "pry"\n  end\n  gem "rspec-rails", "~> 6.0"\nend\ngem "rails"\n');
    assert.equal(m.get('rspec-rails').dev, true);
    assert.equal(m.get('rails').dev, false);
  });

  it('Gemfile.lock: a gem only for other platforms is listed, not missing', () => {
    const lock = (deps) => `GEM\n  remote: https://rubygems.org/\n  specs:\n    rails (7.1.0)\n\nPLATFORMS\n  x86_64-linux\n\nDEPENDENCIES\n${deps}\n`;
    const d = run('Gemfile.lock', lock('  rails'), lock('  rails\n  tzinfo-data'), { Gemfile: 'gem "rails"\n' }, { Gemfile: 'gem "rails"\ngem "tzinfo-data", platforms: %i[ windows jruby ]\n' });
    assert.equal(d.warnings, undefined);
    assert.ok(!d.notes.some((n) => n.includes('tzinfo-data')), d.notes.join('\n'));
  });

  it('hostile manifests and lockfiles stay fast', () => {
    const pad = ' '.repeat(10_000);
    assert.ok(ms(() => c.readManifest('pyproject.toml', `[project]\ndependencies=["a${pad}@\\n"]`)) < 200);
    assert.ok(ms(() => c.readManifest('Gemfile', `group${pad}x\n`)) < 200);
    // Lines under the length cap: no two adjacent patterns may share the spaces.
    assert.ok(ms(() => c.readManifest('Gemfile', `gem${' '.repeat(1000)}x\ngem "a", groups:${' '.repeat(990)}[x\n`.repeat(2000))) < 300);
    assert.ok(ms(() => c.satisfies('npm', `^1${' '.repeat(100_000)}x`, '1.0.0')) < 200);
    assert.ok(ms(() => c.satisfies('packagist', `^1${' '.repeat(100_000)}x`, '1.0.0')) < 200);
    const gem = `GEM\n  remote: https://rubygems.org/\n  specs:\n    foo (${'-x86'.repeat(40_000)} )\n`;
    assert.ok(ms(() => run('Gemfile.lock', gem, gem)) < 500);
  });
});
