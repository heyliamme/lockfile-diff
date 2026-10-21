import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { c, lines, run } from './helpers.mjs';

const json = (o) => JSON.stringify(o, null, 2);
const npm3 = (root, pkgs) => json({ lockfileVersion: 3, packages: { '': root, ...pkgs } });
const mv = (a, b) => {
  const m = c.movement(a, b);
  return `${m.direction > 0 ? 'up' : m.direction < 0 ? 'down' : 'same'} ${m.bump}`;
};

describe('dev flags', () => {
  it("trusts npm's own dev flag over the manifest's devDependencies", () => {
    const root = { dependencies: { express: '^4' }, devDependencies: { debug: '^4' } };
    const d = run(
      'package-lock.json',
      npm3(root, { 'node_modules/express': { version: '4.0.0' }, 'node_modules/debug': { version: '4.0.0' } }),
      npm3(root, { 'node_modules/express': { version: '4.0.0' }, 'node_modules/debug': { version: '4.1.0' } }),
    );
    assert.deepEqual(lines(d), ['upgraded minor debug 4.0.0->4.1.0 D']);
  });

  it("trusts pnpm 6's dev: false", () => {
    const lock = (v) => `lockfileVersion: '6.0'\ndevDependencies:\n  b:\n    specifier: ^1\n    version: ${v}\npackages:\n  /b@${v}:\n    resolution: {integrity: sha512-x}\n    dev: false\n`;
    const d = run('pnpm-lock.yaml', lock('1.0.0'), lock('1.0.1'));
    assert.deepEqual(lines(d), ['upgraded patch b 1.0.0->1.0.1 D']);
  });

  it('a name dev in one workspace and production in another is not dev', () => {
    const lock = (v) =>
      `lockfileVersion: '9.0'\nimporters:\n  packages/a:\n    devDependencies:\n      lodash:\n        specifier: ^4\n        version: ${v}\n  packages/b:\n    dependencies:\n      lodash:\n        specifier: ^4\n        version: ${v}\npackages:\n  lodash@${v}: {}\nsnapshots:\n  lodash@${v}: {}\n`;
    const d = run('pnpm-lock.yaml', lock('4.17.20'), lock('4.17.21'));
    assert.deepEqual(lines(d), ['upgraded patch lodash 4.17.20->4.17.21 D']);
  });
});

describe('go.mod replace', () => {
  const mod = (rep) => `module x\n\ngo 1.22\n\nrequire github.com/a/b v1.4.0\n\n${rep}\n`;
  it('a new replacement version is an upgrade', () => {
    const d = run('go.mod', mod('replace github.com/a/b => github.com/a/b v1.4.0'), mod('replace github.com/a/b => github.com/a/b v1.5.0'));
    assert.deepEqual(lines(d), ['upgraded minor github.com/a/b v1.4.0->v1.5.0 D']);
  });
  it('a fork, in a block', () => {
    const d = run('go.mod', mod('replace github.com/a/b => github.com/a/b v1.4.0'), mod('replace (\n\tgithub.com/a/b v1.4.0 => github.com/fork/b v1.9.0\n)'));
    assert.equal(d.changes.length, 1);
    assert.match(d.changes[0].note, /source changed: registry → replaced by github.com\/fork\/b/);
  });
  it('a local path', () => {
    const d = run('go.mod', mod(''), mod('replace github.com/a/b => ../local'));
    assert.deepEqual(lines(d), ['changed github.com/a/b v1.4.0->v1.4.0 D']);
    assert.equal(d.changes[0].note, 'source changed: registry → replaced by ../local');
  });
});

describe('versions across ecosystems', () => {
  for (const [a, b, want] of [
    ['1.0.0-pre.5', '1.0.0-rc.0', 'up prerelease'],
    ['1.0.0-preview.3', '1.0.0-rc.1', 'up prerelease'],
    ['1.0.0-alpha.3', '1.0.0-b.1', 'up prerelease'],
    ['2.0.0.dev1', '2.0.0a1', 'up prerelease'],
    ['2.0.0a1.dev2', '2.0.0a1', 'up prerelease'],
    ['2.0.0', '2.0.0.post1.dev1', 'up prerelease'],
    ['2.0.0.post1.dev1', '2.0.0.post1', 'up prerelease'],
    ['1.0pre1', '1.0rc1', 'same other'],
    ['1.0.0-dev.1', '1.0.0-alpha.1', 'down prerelease'],
  ]) it(`${a} -> ${b}: ${want}`, () => assert.equal(mv(a, b), want));
  it('dev releases are prereleases', () => assert.equal(c.isPrerelease('2.0.0.dev1'), true));
});

describe('sources', () => {
  it('never shows credentials', () => {
    const lock = (r) => npm3({}, { 'node_modules/foo': { version: '1.0.0', resolved: r } });
    const sha = '#0123456789abcdef0123456789abcdef01234567';
    const d = run('package-lock.json', lock(`git+https://github.com/a/foo.git${sha}`), lock(`git+https://user:ghp_SECRET@github.com/a/foo.git${sha}`));
    assert.equal(d.changes.length, 0, 'the same repository with a token is the same source');
    const e = run('package-lock.json', lock(`git+ssh://git@github.com/a/foo.git${sha}`), lock(`git+https://user:ghp_SECRET@github.com/a/foo.git${sha}`));
    assert.equal(e.changes[0].note, 'source changed: git+ssh://github.com/a/foo.git → git+https://github.com/a/foo.git');
    const md = c.toMarkdown([e]);
    assert.ok(!md.includes('SECRET'), md);
    assert.ok(!JSON.stringify(e).includes('SECRET'));
  });

  it('cleanSource', () => {
    assert.equal(c.cleanSource('https://u:p@host/x?token=1#frag'), 'https://host/x');
    assert.equal(c.cleanSource('git@github.com:a/b.git'), 'git@github.com:a/b.git');
    assert.equal(c.cleanSource('u:tok@github.com:a/b.git'), 'github.com:a/b.git');
  });

  it("a Yarn 1 tarball's hash is not a commit", () => {
    const lock = (v, h) => `"@corp/lib@^1":\n  version "${v}"\n  resolved "https://npm.corp.example.com/@corp/lib/-/lib-${v}.tgz#${h}"\n`;
    const d = run('yarn.lock', lock('1.0.0', '0123456789abcdef0123456789abcdef01234567'), lock('1.1.0', 'fedcba9876543210fedcba9876543210fedcba98'));
    assert.deepEqual(lines(d), ['upgraded minor @corp/lib 1.0.0->1.1.0 ?']);
    assert.equal(d.changes[0].url, 'https://www.npmjs.com/package/@corp/lib/v/1.1.0');
  });

  it('an all-digit commit is not a version', () => {
    const lock = (h) => json({ lockfileVersion: 1, dependencies: { foo: { version: `github:a/foo#${h}` } } });
    const d = run('package-lock.json', lock('1234567890123456789012345678901234567890'), lock('7654321890123456789012345678901234567890'));
    assert.deepEqual(lines(d), ['changed foo @1234567->@7654321 ?']);
  });
});

describe('pairing and directness', () => {
  const lock = (pkgs, direct) => ({ format: 't', ecosystem: 'npm', packages: pkgs.map(([name, version, extra]) => ({ name, version, ...extra })), direct: direct && new Set(direct), notes: [] });
  it('equal counts pair by major first', () => {
    const r = c.diffLocks(lock([['s', '1.0.0'], ['s', '2.0.0']]), lock([['s', '2.0.1'], ['s', '3.0.0']]), 'npm');
    assert.deepEqual(r.changes.map((x) => `${x.kind} ${x.from ?? ''}->${x.to ?? ''}`), ['upgraded 1.0.0->3.0.0', 'upgraded 2.0.0->2.0.1']);
    assert.equal(c.count(r.changes).major, 1);
  });

  it('a nested copy of a direct dependency is transitive', () => {
    const root = { dependencies: { debug: '^4', x: '^1' } };
    const pk = (v) => ({ 'node_modules/debug': { version: '4.0.0' }, 'node_modules/x': { version: '1.0.0' }, 'node_modules/x/node_modules/debug': { version: v } });
    const d = run('package-lock.json', npm3(root, pk('2.6.9')), npm3(root, pk('2.6.10')));
    assert.deepEqual(lines(d), ['upgraded patch debug 2.6.9->2.6.10 t']);
  });

  it('npm aliases are listed and linked under the real name', () => {
    const root = { dependencies: { 'string-width-cjs': 'npm:string-width@^4' } };
    const pk = (v) => ({ 'node_modules/string-width-cjs': { name: 'string-width', version: v } });
    const d = run('package-lock.json', npm3(root, pk('4.2.2')), npm3(root, pk('4.2.3')));
    assert.deepEqual(lines(d), ['upgraded patch string-width 4.2.2->4.2.3 D']);
    assert.equal(d.changes[0].url, 'https://www.npmjs.com/package/string-width/v/4.2.3');
  });

  it('pnpm 9 aliases make the real package direct', () => {
    const lock = (v) => `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      string-width-cjs:\n        specifier: npm:string-width@^4\n        version: string-width@${v}\npackages:\n  string-width@${v}: {}\nsnapshots:\n  string-width@${v}: {}\n`;
    const d = run('pnpm-lock.yaml', lock('4.2.2'), lock('4.2.3'));
    assert.deepEqual(lines(d), ['upgraded patch string-width 4.2.2->4.2.3 D']);
  });
});

describe('markdown escaping', () => {
  it('keeps lockfile text inside its cell', () => {
    const md = c.toMarkdown([{ path: 'p', changes: [{ name: 'x', kind: 'upgraded', bump: 'major', from: '1.0.0', to: '2.0.0\n\n</details>\n\n## All reviewed: none\n\n| x' }] }]);
    assert.equal(md.split('\n').filter((l) => l.startsWith('|')).length, 3, md);
    assert.ok(!/^## /m.test(md));
  });
  it('a name that would end its link early is not linked', () => {
    const name = 'lodash](https://evil.example/x)';
    const md = c.toMarkdown([{ path: 'p', changes: [{ name, kind: 'added', to: '1.0.0', url: c.registryUrl('npm', name, '1.0.0') }] }]);
    assert.ok(!md.includes('](https://evil'), md);
    assert.ok(md.includes('lodash\\]\\(https://evil.example/x\\)'));
  });
});

describe('robustness', () => {
  it('globs run in linear time', () => {
    const t = Date.now();
    assert.equal(c.excluded('a/'.repeat(40) + 'package-lock.json', ['**a'.repeat(16) + '**b']), false);
    assert.ok(Date.now() - t < 500, `${Date.now() - t} ms`);
    assert.equal(c.excluded('a/b/c/package-lock.json', ['**/b/**']), true);
    assert.equal(c.excluded('b/package-lock.json', ['**/b/**']), true);
    assert.equal(c.excluded('ab/package-lock.json', ['**/b/**']), false);
    assert.equal(c.excluded('x/a.lock', ['x/*.lock']), true);
  });

  it('a byte order mark on one side changes nothing', () => {
    const t = `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      a:\n        specifier: ^1\n        version: 1.0.0\npackages:\n  a@1.0.0: {}\nsnapshots:\n  a@1.0.0: {}\n`;
    const d = run('pnpm-lock.yaml', '\uFEFF' + t, t);
    assert.equal(d.error, undefined);
    assert.equal(d.changes.length, 0);
    const pj = json({ dependencies: { a: '^1' } });
    const e = run('yarn.lock', 'a@^1:\n  version "1.0.0"\n', 'a@^1:\n  version "1.0.1"\n', { 'package.json': '\uFEFF' + pj }, { 'package.json': '\uFEFF' + pj });
    assert.deepEqual(lines(e), ['upgraded patch a 1.0.0->1.0.1 D']);
  });
});
