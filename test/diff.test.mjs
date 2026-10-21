import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { c, F, run } from './helpers.mjs';

const lock = (pkgs, direct) => ({ format: 't', ecosystem: 'npm', packages: pkgs.map(([name, version, extra]) => ({ name, version, ...extra })), direct: direct && new Set(direct), notes: [] });
const D = (a, b) => c.diffLocks(a, b, 'npm').changes.map((x) => `${x.kind} ${x.name} ${x.from ?? ''}->${x.to ?? ''}${x.note ? ` (${x.note})` : ''}`);

describe('diffLocks', () => {
  it('pairs several versions of one package by major', () => {
    const a = lock([['ms', '2.0.0'], ['ms', '2.1.2']]);
    const b = lock([['ms', '2.0.1'], ['ms', '2.1.3']]);
    assert.deepEqual(D(a, b), ['upgraded ms 2.0.0->2.0.1', 'upgraded ms 2.1.2->2.1.3']);
  });

  it('a copy that goes away while another is upgraded', () => {
    const a = lock([['debug', '2.6.9'], ['debug', '3.2.7'], ['debug', '4.3.4']]);
    const b = lock([['debug', '4.3.5']]);
    assert.deepEqual(D(a, b), ['upgraded debug 4.3.4->4.3.5', 'removed debug 2.6.9-> (still at 4.3.5)', 'removed debug 3.2.7-> (still at 4.3.5)']);
  });

  it('a new major added next to the old one', () => {
    const a = lock([['chalk', '4.1.2']]);
    const b = lock([['chalk', '4.1.2'], ['chalk', '5.3.0']]);
    assert.deepEqual(D(a, b), ['added chalk ->5.3.0 (another copy alongside 4.1.2)']);
  });

  it('duplicates of the same name@version collapse; dev only when every copy is dev', () => {
    const a = lock([['x', '1.0.0', { dev: true }], ['x', '1.0.0', { dev: false }]]);
    const b = lock([['x', '2.0.0', { dev: true }]]);
    const r = c.diffLocks(a, b, 'npm');
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].dev, true);
  });

  it('source changes with the same version are reported', () => {
    const a = lock([['x', '1.0.0']]);
    const b = lock([['x', '1.0.0', { source: 'npm.acme.dev' }]]);
    assert.deepEqual(D(a, b), ['changed x 1.0.0->1.0.0 (source changed: registry → npm.acme.dev)']);
  });

  it('removed packages take direct from the old side', () => {
    const r = c.diffLocks(lock([['a', '1.0.0']], ['a']), lock([], []), 'npm');
    assert.equal(r.changes[0].direct, true);
  });

  it('sorts: upgrades by severity, then downgrades, added, removed, changed', () => {
    const a = lock([['p', '1.0.0'], ['m', '1.0.0'], ['d', '2.0.0'], ['r', '1.0.0'], ['g', '1.0.0@aaaaaaa']]);
    const b = lock([['p', '1.0.1'], ['m', '2.0.0'], ['d', '1.0.0'], ['n', '1.0.0'], ['g', '1.0.0@bbbbbbb']]);
    assert.deepEqual(D(a, b).map((s) => s.split(' ').slice(0, 2).join(' ')), ['upgraded m', 'upgraded p', 'downgraded d', 'added n', 'removed r', 'changed g']);
  });

  it('counts majors among upgrades only', () => {
    const r = c.diffLocks(lock([['a', '1.0.0'], ['b', '2.0.0']]), lock([['a', '2.0.0'], ['b', '1.0.0']]), 'npm');
    const counts = c.count(r.changes);
    assert.equal(counts.major, 1);
    assert.equal(c.summarize(counts), '1 upgraded (1 major), 1 downgraded');
  });
});

describe('markdown', () => {
  it('writes a table per lockfile with links, tags and notes', () => {
    const d = run('package-lock.json', F('npm/v3/old.json'), F('npm/v3/new.json'));
    const md = c.toMarkdown([d], { range: 'main → Working Tree' });
    const out = md.split('\n');
    assert.equal(out[0], '### Dependency changes');
    assert.equal(out[2], '3 added, 1 removed, 6 upgraded (4 major), 1 changed (main → Working Tree).');
    assert.ok(md.includes('| [react](https://www.npmjs.com/package/react/v/18.2.0) (direct) | major upgrade | `17.0.2` | `18.2.0` |'));
    assert.ok(md.includes('| [ms](https://www.npmjs.com/package/ms/v/2.1.3) | patch upgrade, also at 2.0.0 | `2.1.2` | `2.1.3` |'));
    assert.ok(md.includes('| [typescript](https://www.npmjs.com/package/typescript/v/5.4.5) (direct, dev) |'));
    assert.ok(!md.includes('<details>'));
  });

  it('collapses long tables, names each file, and escapes pipes', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `p${i}|x`, kind: 'added', to: '1.0.0' }));
    const md = c.toMarkdown([
      { path: 'a/package-lock.json', changes: many },
      { path: 'Cargo.lock', changes: [], error: 'Cargo.lock in HEAD: bad' },
    ]);
    assert.ok(md.includes('**a/package-lock.json**: 30 added'));
    assert.ok(md.includes('<details><summary>30 changes</summary>'));
    assert.ok(md.includes('| p0\\|x | added |  | `1.0.0` |'));
    assert.ok(md.includes('**Cargo.lock**: Cargo.lock in HEAD: bad'));
  });

  it('says so when nothing changed', () => {
    assert.equal(c.toMarkdown([{ path: 'x', changes: [] }]), '### Dependency changes\n\nNo dependency changes.\n');
  });
});

describe('excludes', () => {
  it('matches globs relative to the repository root', () => {
    assert.equal(c.excluded('examples/demo/package-lock.json', ['examples/**']), true);
    assert.equal(c.excluded('packages/a/test/fixtures/yarn.lock', ['**/fixtures/**']), true);
    assert.equal(c.excluded('fixtures/yarn.lock', ['**/fixtures/**']), true);
    assert.equal(c.excluded('package-lock.json', ['**/fixtures/**']), false);
    assert.equal(c.excluded('a/Cargo.lock', ['*/Cargo.lock']), true);
    assert.equal(c.excluded('a/b/Cargo.lock', ['*/Cargo.lock']), false);
    assert.equal(c.excluded('docs/go.sum', ['{docs,site}/**']), true);
    assert.equal(c.excluded('x(1)/go.sum', ['x(1)/*']), true);
  });

  it('go.mod and go.sum in one folder are one comparison', () => {
    assert.deepEqual(c.dedupeGo(['go.sum', 'go.mod', 'tools/go.sum', 'package-lock.json']), ['go.mod', 'tools/go.sum', 'package-lock.json']);
  });
});

describe('across formats', () => {
  it('npm -> pnpm: a migration shows what really moved', () => {
    const d = c.analyze(
      'pnpm-lock.yaml',
      { label: 'main', text: F('npm/v3/old.json'), fileName: 'package-lock.json' },
      { label: 'branch', text: [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      react:',
        '        specifier: ^17.0.2',
        '        version: 17.0.2',
        'packages:',
        '  react@17.0.2: {}',
        '  loose-envify@1.4.0: {}',
        '',
      ].join('\n'), fileName: 'pnpm-lock.yaml' },
    );
    assert.equal(d.error, undefined);
    assert.equal(d.unchanged, 2);
    assert.equal(d.counts.removed, 14);
    assert.ok(d.notes.includes('Format changed: package-lock.json v3 → pnpm-lock.yaml 9.0.'));
  });

  it('refuses to compare two ecosystems', () => {
    const d = c.analyze('Cargo.lock', { label: 'a', text: F('npm/v3/old.json'), fileName: 'package-lock.json' }, { label: 'b', text: F('cargo/new.lock'), fileName: 'Cargo.lock' });
    assert.match(d.error, /different ecosystems/);
  });
});
