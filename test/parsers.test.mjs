import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { c, F, lines, run, summary } from './helpers.mjs';

describe('npm', () => {
  const expected = [
    'upgraded major @types/node 18.19.3->20.12.7 D dev',
    'upgraded major react 17.0.2->18.2.0 D',
    'upgraded major send 0.18.0->0.19.0 D',
    'upgraded major typescript 4.9.5->5.4.5 D dev',
    'upgraded patch lodash 4.17.20->4.17.21 D',
    'upgraded patch ms 2.1.2->2.1.3 t',
    'added scheduler ->0.23.0 t',
    'added undici-types ->5.26.5 t dev',
    'added zod ->3.23.8 D',
    'removed object-assign 4.1.1-> t',
  ];
  for (const v of [2, 3]) {
    it(`package-lock.json v${v}: nested copies, dev flags, direct from the root entry`, () => {
      const d = run('package-lock.json', F(`npm/v${v}/old.json`), F(`npm/v${v}/new.json`));
      assert.equal(d.format, `package-lock.json v${v}`);
      assert.equal(summary(d), '3 added, 1 removed, 6 upgraded (4 major), 1 changed');
      assert.deepEqual(lines(d).slice(0, 10), expected);
      assert.equal(lines(d)[10], 'changed left-pad 1.3.0@2fca615->1.3.0@9e1ab8b D');
      // ms 2.0.0 stays nested under send/debug, so the upgrade notes it.
      assert.equal(d.changes.find((x) => x.name === 'ms').note, 'also at 2.0.0');
      assert.equal(d.unchanged, 8);
      assert.ok(d.directKnown);
    });
  }

  it('npm-shrinkwrap.json v1: the dependency tree, direct from package.json', () => {
    const d = run('npm-shrinkwrap.json', F('npm/v1/old.json'), F('npm/v1/new.json'), { 'package.json': F('npm/v1/old.package.json') }, { 'package.json': F('npm/v1/new.package.json') });
    assert.equal(d.format, 'npm-shrinkwrap.json v1');
    assert.deepEqual(lines(d).slice(0, 10), expected);
    assert.equal(lines(d)[10], 'changed left-pad @2fca615->@9e1ab8b D');
    assert.deepEqual(d.notes, ['Direct dependencies come from package.json.']);
  });

  it('v1 without package.json: direct is unknown', () => {
    const d = run('package-lock.json', F('npm/v1/old.json'), F('npm/v1/new.json'));
    assert.equal(d.directKnown, false);
    assert.equal(d.changes.find((x) => x.name === 'react').direct, undefined);
  });

  it('skips workspace links and the root project', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'mono', workspaces: ['packages/*'], dependencies: { a: '1' } },
        'packages/web': { name: 'web', version: '0.0.1', dependencies: { b: '^2' } },
        'node_modules/web': { resolved: 'packages/web', link: true },
        'node_modules/a': { version: '1.0.0' },
        'node_modules/b': { version: '2.0.0' },
      },
    });
    const p = c.parserFor('package-lock.json').parse(lock, { fileName: 'package-lock.json', siblings: {} });
    assert.deepEqual(p.packages.map((x) => x.name), ['a', 'b']);
    assert.deepEqual([...p.direct], ['a', 'b']);
  });

  it('a package from another registry shows its host, never credentials', () => {
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/x': { version: '1.0.0', resolved: 'https://user:secret@npm.acme.dev/x/-/x-1.0.0.tgz' } } });
    const p = c.parserFor('package-lock.json').parse(lock, { fileName: 'package-lock.json', siblings: {} });
    assert.equal(p.packages[0].source, 'npm.acme.dev');
  });

  it('sha1 -> sha512 integrity is not a change; a new sha512 for the same version is', () => {
    const mk = (i) => JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/x': { version: '1.0.0', integrity: i } } });
    assert.equal(run('package-lock.json', mk('sha1-abc'), mk('sha512-def')).changes.length, 0);
    const d = run('package-lock.json', mk('sha512-abc'), mk('sha512-def'));
    assert.deepEqual(lines(d), ['changed x 1.0.0->1.0.0 ?']);
    assert.equal(d.changes[0].note, 'checksum changed with the same version');
  });
});

describe('yarn', () => {
  it('yarn.lock v1: several ranges for one version, two majors side by side, git commits', () => {
    const d = run('yarn.lock', F('yarn/classic-old.lock'), F('yarn/classic-new.lock'), { 'package.json': F('yarn/classic.package.json') }, { 'package.json': F('yarn/classic.package.json') });
    assert.equal(d.format, 'yarn.lock (Yarn 1)');
    assert.equal(summary(d), '1 added, 6 upgraded (1 major)');
    assert.deepEqual(lines(d), [
      'upgraded major chalk 4.1.2->5.3.0 D',
      'upgraded minor @babel/code-frame 7.22.13->7.24.2 t',
      'upgraded minor @babel/highlight 7.22.20->7.24.2 t',
      'upgraded minor my-private-lib 1.0.0@3b2c9d0->1.1.0@8f7e6d5 D',
      'upgraded minor typescript 5.2.2->5.4.5 D dev',
      'upgraded patch lodash 4.17.20->4.17.21 D',
      'added picocolors ->1.0.0 t',
    ]);
    assert.equal(d.changes[0].note, 'also at 2.4.2');
    // A git commit is not a registry version: the link goes to the package page.
    assert.equal(d.changes.find((x) => x.name === 'my-private-lib').url, 'https://www.npmjs.com/package/my-private-lib');
  });

  it('yarn.lock v2+: workspace entries give the direct dependencies, patch entries are not counted twice', () => {
    const d = run('yarn.lock', F('yarn/berry-old.lock'), F('yarn/berry-new.lock'));
    assert.equal(d.format, 'yarn.lock (Yarn 2+, v8)');
    assert.deepEqual(lines(d), [
      'upgraded major react 18.2.0->19.0.0-rc.1 D',
      'upgraded minor @types/react 18.2.21->18.3.3 D',
      'upgraded patch @types/prop-types 15.7.5->15.7.12 t',
      'upgraded patch csstype 3.1.2->3.1.3 t',
      'upgraded patch resolve 1.22.4->1.22.8 D',
      'removed js-tokens 4.0.0-> t',
      'removed loose-envify 1.4.0-> t',
    ]);
    // lodash kept its version; only the cache key (and so the checksum) changed.
    assert.equal(d.unchanged, 1);
  });

  it('reports the line of something that is not a yarn.lock entry', () => {
    const d = run('yarn.lock', 'lodash@^4:\n  version "4.17.21"\nnot an entry\n', '');
    assert.match(d.error, /yarn\.lock in before: yarn\.lock: unexpected line 3/);
  });
});

describe('pnpm', () => {
  it('5.4 -> 6.0: old and new key styles, peer suffixes, single-project direct deps', () => {
    const d = run('pnpm-lock.yaml', F('pnpm/v5.yaml'), F('pnpm/v6.yaml'));
    assert.equal(d.format, 'pnpm-lock.yaml 6.0');
    assert.deepEqual(d.notes, ['Format changed: pnpm-lock.yaml 5.4 → pnpm-lock.yaml 6.0.']);
    assert.deepEqual(lines(d), [
      'upgraded major @vitejs/plugin-react 2.2.0->4.3.0 D dev',
      'upgraded major vite 3.2.4->5.2.11 D dev',
      'upgraded minor react 18.2.0->18.3.1 D',
      'upgraded minor react-dom 18.2.0->18.3.1 D',
      'upgraded patch scheduler 0.23.0->0.23.2 t',
      'added react-refresh ->0.14.2 t dev',
      'removed magic-string 0.26.7-> t dev',
      'removed sourcemap-codec 1.4.8-> t dev',
    ]);
  });

  it('9.0: importers of a workspace, two versions of one package', () => {
    const d = run('pnpm-lock.yaml', F('pnpm/v9-old.yaml'), F('pnpm/v9-new.yaml'));
    assert.deepEqual(lines(d), [
      'upgraded major avvio 8.3.0->9.0.0 t',
      'upgraded major fastify 4.26.2->5.0.0 D',
      'upgraded minor typescript 5.4.5->5.6.3 D dev',
      'added zod ->3.23.8 D',
    ]);
    assert.equal(d.changes[3].note, 'another copy alongside 3.22.4');
  });

  it('needs a lockfileVersion', () => {
    assert.match(run('pnpm-lock.yaml', 'packages: {}\n', 'packages: {}\n').error, /no lockfileVersion/);
  });
});

describe('bun', () => {
  it('bun.lock: trailing commas, nested copies, workspaces', () => {
    const d = run('bun.lock', F('bun/old.lock'), F('bun/new.lock'));
    assert.equal(d.format, 'bun.lock v1');
    assert.deepEqual(lines(d), [
      'upgraded minor @types/bun 1.0.12->1.1.6 D dev',
      'upgraded minor bun-types 1.0.33->1.1.17 t',
      'upgraded minor elysia 1.0.9->1.1.4 D',
      'upgraded patch @sinclair/typebox 0.32.20->0.32.35 t',
      'added @types/node ->20.12.14 t',
      'added @types/ws ->8.5.10 t',
      'added undici-types ->5.26.5 t',
      'added valibot ->0.31.1 D',
    ]);
  });

  it('bun.lockb is explained, not parsed', () => {
    assert.match(run('bun.lockb', 'x', 'y').error, /binary lockfile/);
  });
});

describe('pub', () => {
  it('pubspec.lock: direct main / direct dev / transitive, git packages', () => {
    const d = run('pubspec.lock', F('pub/old.lock'), F('pub/new.lock'));
    assert.deepEqual(lines(d), [
      'upgraded major flutter_lints 2.0.3->4.0.0 D dev',
      'upgraded major go_router 13.2.0->14.2.7 D',
      'upgraded major lints 2.1.1->4.0.0 t',
      'upgraded minor collection 1.18.0->1.19.0 t',
      'upgraded minor flutter_riverpod 2.4.10->2.5.1 D',
      'upgraded patch riverpod 2.5.0->2.5.1 t',
      'added local_auth ->2.3.0@5c3a6e6 D',
      'removed shared_preferences 2.2.2-> D',
    ]);
    assert.equal(d.changes[1].url, 'https://pub.dev/packages/go_router/versions/14.2.7');
  });
});

describe('python', () => {
  it('poetry.lock: names normalized, pre-releases, direct from pyproject.toml', () => {
    const d = run('poetry.lock', F('python/poetry-old.lock'), F('python/poetry-new.lock'), {}, { 'pyproject.toml': F('python/pyproject.toml') });
    assert.equal(d.format, 'poetry.lock 2.0');
    assert.deepEqual(lines(d), [
      'upgraded major anyio 3.7.1->4.4.0 D',
      'upgraded major django 4.2.11->5.0.6 D',
      'upgraded major pytest 7.4.4->8.2.0rc1 D dev',
      'upgraded minor asgiref 3.7.2->3.8.1 t',
      'upgraded minor idna 3.6->3.7 t',
      'upgraded minor sqlparse 0.4.4->0.5.0 t',
      'upgraded patch sniffio 1.3.0->1.3.1 t',
      'added typing-extensions ->4.12.2 t',
    ]);
    assert.equal(d.changes[1].url, 'https://pypi.org/project/django/5.0.6/');
  });

  it('uv.lock: the editable project names the direct dependencies', () => {
    const d = run('uv.lock', F('python/uv-old.lock'), F('python/uv-new.lock'));
    assert.deepEqual(lines(d), [
      'upgraded minor certifi 2024.2.2->2024.8.30 t',
      'upgraded minor httpx 0.26.0->0.27.2 D',
      'upgraded minor ruff 0.3.4->0.6.9 D dev',
      'removed charset-normalizer 3.3.2-> t',
      'removed requests 2.31.0-> D',
    ]);
  });

  it('reports TOML errors', () => {
    assert.match(run('uv.lock', '[[package]\nname = 1', F('python/uv-new.lock')).error, /uv\.lock in before: uv\.lock is not valid TOML/);
  });
});

describe('cargo', () => {
  it('Cargo.lock: two majors of one crate, git sources, root crates', () => {
    const d = run('Cargo.lock', F('cargo/old.lock'), F('cargo/new.lock'));
    assert.deepEqual(lines(d), [
      'upgraded minor bitflags 2.4.2->2.6.0 t',
      'upgraded minor clap 4.4.18->4.5.20 D',
      'upgraded patch serde 1.0.196->1.0.210 D',
      'added thiserror ->2.0.0 D',
      'changed tokio 1.35.1@4a2b6c8->1.35.1@9f8e7d6 D',
    ]);
    assert.equal(d.changes[0].note, 'also at 1.3.2');
    assert.equal(d.changes[4].bump, undefined);
  });
});

describe('go', () => {
  it('go.sum with go.mod: versions and direct from go.mod', () => {
    const d = run('go.sum', F('go/old.sum'), F('go/new.sum'), { 'go.mod': F('go/old.mod') }, { 'go.mod': F('go/new.mod') });
    assert.equal(d.format, 'go.mod');
    assert.deepEqual(lines(d), [
      'upgraded minor github.com/go-chi/chi/v5 v5.0.10->v5.1.0 D',
      'upgraded minor github.com/jackc/pgx/v5 v5.5.1->v5.6.0 D',
      'upgraded minor golang.org/x/crypto v0.17.0->v0.24.0 t',
      'upgraded minor golang.org/x/sync v0.5.0->v0.7.0 t',
      'upgraded minor golang.org/x/text v0.14.0->v0.16.0 t',
      'upgraded other github.com/jackc/pgservicefile v0.0.0-20221227161230-091c0ba34f0a->v0.0.0-20240606120523-5a60cdf6a761 t',
      'added github.com/google/uuid ->v1.6.0 D',
      'added github.com/jackc/puddle/v2 ->v2.2.1 t',
    ]);
    assert.equal(d.changes[0].url, 'https://pkg.go.dev/github.com/go-chi/chi/v5@v5.1.0');
  });

  it('go.mod opened directly', () => {
    const d = run('go.mod', F('go/old.mod'), F('go/new.mod'));
    assert.equal(summary(d), '2 added, 6 upgraded');
  });

  it('go.sum alone: only module zips count, not go.mod hashes', () => {
    const d = run('go.sum', F('go/old.sum'), F('go/new.sum'));
    assert.equal(d.format, 'go.sum');
    assert.equal(summary(d), '1 added, 5 upgraded');
    assert.equal(d.directKnown, false);
  });

  it('reads single-line requires', () => {
    assert.deepEqual(c.goModRequires('module x\nrequire golang.org/x/mod v0.14.0 // indirect\nrequire "a/b" v1.0.0\n'), [
      { path: 'golang.org/x/mod', version: 'v0.14.0', indirect: true },
      { path: 'a/b', version: 'v1.0.0', indirect: false },
    ]);
  });
});

describe('composer', () => {
  it('composer.lock: packages and packages-dev, branches pinned to commits', () => {
    const d = run('composer.lock', F('composer/old.lock'), F('composer/new.lock'), { 'composer.json': F('composer/composer.json') }, { 'composer.json': F('composer/composer.json') });
    assert.deepEqual(lines(d), [
      'upgraded major monolog/monolog 2.9.2->3.7.0 D',
      'upgraded major phpunit/phpunit 10.5.10->11.3.6 D dev',
      'upgraded major psr/log 1.1.4->3.0.2 t',
      'upgraded minor guzzlehttp/guzzle 7.8.1->7.9.2 D',
      'upgraded patch guzzlehttp/promises 2.0.2->2.0.3 t',
      'changed acme/internal-sdk dev-main#5d4c3b2->dev-main#9a8b7c6 D',
    ]);
    assert.equal(d.changes[0].url, 'https://packagist.org/packages/monolog/monolog');
  });
});

describe('ruby', () => {
  it('Gemfile.lock: platform builds collapse, GIT revisions, DEPENDENCIES are direct', () => {
    const d = run('Gemfile.lock', F('ruby/old.lock'), F('ruby/new.lock'));
    assert.equal(summary(d), '1 added, 9 upgraded (1 major), 1 changed');
    assert.deepEqual(lines(d).slice(0, 2), ['upgraded major rack 2.2.8->3.1.7 t', 'upgraded minor actionpack 7.0.8->7.1.3.4 D']);
    assert.ok(lines(d).includes('upgraded minor nokogiri 1.15.5->1.16.7 D'));
    assert.ok(lines(d).includes('changed feature_flags 0.4.0@1a2b3c4->0.4.0@7f6e5d4 D'));
    assert.ok(lines(d).includes('added rails-html-sanitizer ->1.6.0 D'));
    assert.equal(d.changes[0].url, 'https://rubygems.org/gems/rack/versions/3.1.7');
  });
});

describe('robustness', () => {
  const files = Object.keys(c.LOCKFILES);
  const junk = ['', '{', '[]', 'null', '\u0000\u0001\u0002', '- a\n- b\n', 'key: [unclosed', '[[package]]\nname = "x"\n', '"a":\n  - 1', 'x'.repeat(5000)];
  for (const f of files) {
    it(`${f}: junk input gives a message or an empty result, never a throw`, () => {
      for (const j of junk) {
        const d = run(f, j, j);
        assert.ok(d.error === undefined || typeof d.error === 'string');
        assert.ok(Array.isArray(d.changes));
      }
    });
  }

  it('a file that is new on one side counts everything as added', () => {
    const d = run('pubspec.lock', undefined, F('pub/new.lock'));
    assert.equal(d.counts.added, 11);
    assert.equal(d.notes[0], 'New in after: every package counts as added.');
  });

  it('a file missing on both sides is an error', () => {
    assert.match(run('Cargo.lock', undefined, undefined).error, /exists in neither/);
  });

  it('a malformed side names the side and the position', () => {
    assert.equal(run('composer.lock', '{\n  "packages": [\n}', '{}').error, 'composer.lock in before: composer.lock is not valid JSON (line 3, column 1).');
  });
});
