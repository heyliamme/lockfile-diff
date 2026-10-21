import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { c, run } from './helpers.mjs';

const cls = (eco, a, b) => {
  const m = c.classify(eco, a, b);
  return `${m.bump}${m.flag ? ` ${m.flag}` : ''}`;
};

describe('0.x versions per ecosystem', () => {
  it('caret ecosystems: a 0.x minor and a 0.0.x patch are breaking', () => {
    for (const eco of ['npm', 'cargo', 'packagist']) {
      assert.equal(cls(eco, '0.2.1', '0.3.0'), 'major breaking', eco);
      assert.equal(cls(eco, '0.0.3', '0.0.4'), 'major breaking', eco);
      assert.equal(cls(eco, '0.2.1', '0.2.2'), 'patch', eco);
      assert.equal(cls(eco, '1.2.0', '1.3.0'), 'minor', eco);
    }
    assert.match(c.classify('npm', '0.18.0', '0.19.0').why, /\^0\.18 doesn't accept 0\.19\.0/);
    assert.match(c.classify('cargo', '0.2.1', '0.3.0').why, /Cargo/);
  });
  it('downgrades follow the same rule', () => {
    assert.equal(cls('npm', '0.3.0', '0.2.9'), 'major breaking');
  });
  it('pub: 0.x minor is breaking, 0.0.x patch is not', () => {
    assert.equal(cls('pub', '0.2.1', '0.3.0'), 'major breaking');
    assert.equal(cls('pub', '0.0.3', '0.0.4'), 'patch');
  });
  it('PEP 440 and RubyGems: versions mean what they say', () => {
    assert.equal(cls('pypi', '0.2.1', '0.3.0'), 'minor');
    assert.equal(cls('rubygems', '0.2.1', '0.3.0'), 'minor');
  });
  it('Go v0: marked as promising nothing, not counted as major', () => {
    assert.equal(cls('go', 'v0.17.0', 'v0.24.0'), 'minor v0');
    assert.match(c.classify('go', 'v0.17.0', 'v0.24.0').why, /no compatibility promise/);
    assert.equal(cls('go', 'v1.2.0', 'v1.3.0'), 'minor');
  });
});

describe('Go pseudo-versions', () => {
  it('reads the three forms', () => {
    assert.deepEqual(c.parsePseudo('v0.0.0-20240102150405-abcdef123456'), { date: '2024-01-02', commit: 'abcdef1', form: 'none' });
    assert.deepEqual(c.parsePseudo('v1.2.4-0.20240102150405-abcdef123456'), { base: 'v1.2.3', date: '2024-01-02', commit: 'abcdef1', form: 'release' });
    assert.deepEqual(c.parsePseudo('v1.3.0-rc.1.0.20240102150405-abcdef123456'), { base: 'v1.3.0-rc.1', date: '2024-01-02', commit: 'abcdef1', form: 'pre' });
    assert.equal(c.parsePseudo('v1.2.3'), undefined);
    assert.equal(c.parsePseudo('v1.2.3-rc.1'), undefined);
  });
  it('two commits after the same tag: a commit change, newest wins, with dates', () => {
    const m = c.classify('go', 'v0.0.0-20221227161230-091c0ba34f0a', 'v0.0.0-20240606120523-5a60cdf6a761');
    assert.deepEqual([m.direction, m.bump, m.flag], [1, 'other', 'commit']);
    assert.equal(m.why, 'commit 091c0ba (2022-12-27) → commit 5a60cdf (2024-06-06)');
  });
  it('a release to a commit after it is a patch; a new base is a real bump', () => {
    assert.equal(cls('go', 'v1.2.3', 'v1.2.4-0.20240102150405-abcdef123456'), 'patch commit');
    assert.equal(cls('go', 'v1.2.4-0.20240102150405-abcdef123456', 'v1.2.4'), 'patch commit');
    assert.equal(cls('go', 'v1.2.4-0.20240102150405-abcdef123456', 'v2.0.0'), 'major commit');
  });
  it('shows as commit and date', () => {
    assert.equal(c.displayVersion('go', 'v0.0.0-20240102150405-abcdef123456'), 'abcdef1 (2024-01-02)');
    assert.equal(c.displayVersion('npm', '1.0.0'), '1.0.0');
  });
});

describe('declared ranges', () => {
  const sat = (eco, range, v) => c.satisfies(eco, range, v);
  it('npm', () => {
    assert.equal(sat('npm', '^18.0.0', '18.2.0'), true);
    assert.equal(sat('npm', '^18.0.0', '17.0.2'), false);
    assert.equal(sat('npm', '^0.2.1', '0.3.0'), false);
    assert.equal(sat('npm', '~1.2.3', '1.2.9'), true);
    assert.equal(sat('npm', '~1.2.3', '1.3.0'), false);
    assert.equal(sat('npm', '1.x || >=3 <4', '3.1.0'), true);
    assert.equal(sat('npm', '>= 2.1.2 < 3', '2.5.0'), true);
    assert.equal(sat('npm', '1.2.3 - 2.3', '2.3.9'), true);
    assert.equal(sat('npm', '1.2', '1.2.7'), true);
    assert.equal(sat('npm', '^1.0.0', '1.1.0-beta.1'), false);
    assert.equal(sat('npm', 'npm:string-width@^4.2.0', '4.2.3'), true);
    assert.equal(sat('npm', 'latest', '4.2.3'), true);
    assert.equal(sat('npm', 'next-tag', '4.2.3'), undefined);
  });
  it('Cargo, Composer, pub, PEP 440, RubyGems', () => {
    assert.equal(sat('cargo', '1.2', '1.9.0'), true);
    assert.equal(sat('cargo', '0.4', '0.5.0'), false);
    assert.equal(sat('cargo', '>=1.2, <1.5', '1.5.0'), false);
    assert.equal(sat('packagist', '~1.2', '1.9.0'), true);
    assert.equal(sat('packagist', '^2.0 || ^3.0', '3.0.2'), true);
    assert.equal(sat('packagist', '>=1.0 <2.0', '2.0.0'), false);
    assert.equal(sat('pub', '^0.2.3', '0.3.0'), false);
    assert.equal(sat('pub', '^0.0.3', '0.0.9'), true);
    assert.equal(sat('pub', '>=1.0.0 <2.0.0', '1.5.0'), true);
    assert.equal(sat('pypi', '>=2.0,<3', '2.31.0'), true);
    assert.equal(sat('pypi', '~=1.4.2', '1.5.0'), false);
    assert.equal(sat('pypi', '==1.*', '1.9'), true);
    assert.equal(sat('pypi', '^1.2', '2.0.0'), false);
    assert.equal(sat('rubygems', '~> 7.1, >= 7.1.2', '7.2.0'), true);
    assert.equal(sat('rubygems', '~> 7.1.2', '7.2.0'), false);
  });

  it('reads each manifest', () => {
    const r = (f, t) => Object.fromEntries([...c.readManifest(f, t)].map(([k, v]) => [k, `${v.range}${v.dev ? ' dev' : ''}${v.registry ? '' : ' !reg'}`]));
    assert.deepEqual(r('package.json', JSON.stringify({ dependencies: { react: '^18', cjs: 'npm:string-width@^4', local: 'file:../x' }, devDependencies: { vitest: '^1' } })), {
      vitest: '^1 dev',
      react: '^18',
      cjs: 'npm:string-width@^4',
      local: 'file:../x !reg',
    });
    assert.deepEqual(r('pubspec.yaml', 'name: app\ndependencies:\n  http: ^1.2.0\n  flutter:\n    sdk: flutter\n  mine:\n    git: https://x/y\ndev_dependencies:\n  lints: ^3.0.0\n'), {
      lints: '^3.0.0 dev',
      http: '^1.2.0',
      flutter: 'sdk !reg',
      mine: 'git !reg',
    });
    assert.deepEqual(r('Cargo.toml', '[dependencies]\nserde = { version = "1.0", features = ["derive"] }\nitoa = "1"\nmy-rand = { package = "rand", version = "0.8" }\nlocal = { path = "../l" }\n[dev-dependencies]\ninsta = "1.39"\n'), {
      insta: '1.39 dev',
      serde: '1.0',
      itoa: '1',
      rand: '0.8',
      local: 'path !reg',
    });
    assert.deepEqual(r('pyproject.toml', '[project]\ndependencies = ["Requests[socks] >=2.31,<3 ; python_version>\'3.8\'", "attrs"]\n[dependency-groups]\ndev = ["pytest>=8"]\n'), {
      pytest: '>=8 dev',
      requests: '>=2.31,<3',
      attrs: '*',
    });
    assert.deepEqual(r('pyproject.toml', '[tool.poetry.dependencies]\npython = "^3.11"\nsix = "^1.16"\n[tool.poetry.group.dev.dependencies]\niniconfig = "^2"\n'), { iniconfig: '^2 dev', six: '^1.16' });
    assert.deepEqual(r('composer.json', JSON.stringify({ require: { php: '>=8.1', 'Monolog/Monolog': '^3.0' }, 'require-dev': { 'phpunit/phpunit': '^10' } })), {
      'phpunit/phpunit': '^10 dev',
      'monolog/monolog': '^3.0',
    });
    assert.deepEqual(r('Gemfile', 'source "https://rubygems.org"\ngem "rails", "~> 7.1", ">= 7.1.2"\ngem "puma"\ngem "mine", git: "https://x/y"\ngroup :development, :test do\n  gem "rspec", "~> 3.13" # tests\nend\n'), {
      rails: '~> 7.1, >= 7.1.2',
      puma: '>= 0',
      mine: 'git !reg',
      rspec: '~> 3.13 dev',
    });
  });
});

describe('manifest next to the lockfile', () => {
  const lock = (deps) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { dependencies: Object.fromEntries(Object.keys(deps).map((k) => [k, '*'])) }, ...Object.fromEntries(Object.entries(deps).map(([k, v]) => [`node_modules/${k}`, { version: v }])) },
    });
  const pkg = (deps) => JSON.stringify({ dependencies: deps });

  it('puts the declared range change on the row', () => {
    const d = run('package-lock.json', lock({ react: '17.0.2', ms: '2.1.2' }), lock({ react: '18.2.0', ms: '2.1.2' }), { 'package.json': pkg({ react: '^17.0.2', ms: '^2.1.0' }) }, { 'package.json': pkg({ react: '^18.2.0', ms: '^2.1.0' }) });
    assert.deepEqual(d.changes[0].range, { from: '^17.0.2', to: '^18.2.0' });
    assert.equal(d.warnings, undefined);
  });

  it('warns when the manifest changed and the lockfile did not', () => {
    const l = lock({ react: '17.0.2' });
    const d = run('package-lock.json', l, l, { 'package.json': pkg({ react: '^17.0.2' }) }, { 'package.json': pkg({ react: '^18.2.0', zod: '^3' }) });
    assert.equal(d.lockUnchanged, true);
    assert.deepEqual(d.warnings, [
      "package.json changes 2 dependencies, but package-lock.json didn't change: the lockfile wasn't updated.",
      'Declared in package.json but not in package-lock.json: zod.',
      'package-lock.json has versions outside the range package.json now declares: react (^18.2.0; locked 17.0.2).',
    ]);
    assert.ok(d.notes.some((n) => n.startsWith('Changed in package.json: react ^17.0.2 → ^18.2.0, zod (new) → ^3')));
  });

  it('a range change the locked version already satisfies is a note, not a warning', () => {
    const l = lock({ lodash: '4.17.21' });
    const l2 = lock({ lodash: '4.17.21', ms: '2.1.3' });
    const d = run('package-lock.json', l, l2, { 'package.json': pkg({ lodash: '^4.17.20' }) }, { 'package.json': pkg({ lodash: '^4.17.21', ms: '^2' }) });
    assert.equal(d.warnings, undefined);
    assert.ok(d.notes.includes('Declared ranges that changed in package.json with no change in package-lock.json: lodash ^4.17.20 → ^4.17.21.'));
  });

  it('nothing without both manifests looked up', () => {
    const d = run('package-lock.json', lock({ react: '17.0.2' }), lock({ react: '18.2.0' }));
    assert.equal(d.manifest, undefined);
    assert.equal(d.changes[0].range, undefined);
  });
});

describe('npm aliases', () => {
  it('package-lock v3: the real package, installed under the alias', () => {
    const l = (v) => JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { cjs: 'npm:string-width@^4' } }, 'node_modules/cjs': { name: 'string-width', version: v } } });
    const d = run('package-lock.json', l('4.2.0'), l('4.2.3'));
    assert.deepEqual([d.changes[0].name, d.changes[0].alias, d.changes[0].direct], ['string-width', 'cjs', true]);
  });
  it('yarn 1: the alias key names the real package', () => {
    const y = (v) => `"cjs@npm:string-width@^4":\n  version "${v}"\n  resolved "https://registry.yarnpkg.com/string-width/-/string-width-${v}.tgz"\n`;
    const d = run('yarn.lock', y('4.2.0'), y('4.2.3'));
    assert.deepEqual([d.changes[0].name, d.changes[0].alias], ['string-width', 'cjs']);
  });
  it('pnpm 9: the importer names the alias', () => {
    const p = (v) => `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      cjs:\n        specifier: npm:string-width@^4\n        version: string-width@${v}\npackages:\n  string-width@${v}:\n    resolution: {integrity: sha512-x}\nsnapshots:\n  string-width@${v}: {}\n`;
    const d = run('pnpm-lock.yaml', p('4.2.0'), p('4.2.3'));
    assert.deepEqual([d.changes[0].name, d.changes[0].alias, d.changes[0].direct], ['string-width', 'cjs', true]);
  });
});
