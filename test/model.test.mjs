import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { c, F, run } from './helpers.mjs';

const require = createRequire(import.meta.url);
const m = require('../dist/model.js');

const npm = () => run('package-lock.json', F('npm/v3/old.json'), F('npm/v3/new.json'));
const cargo = () => run('Cargo.lock', F('cargo/old.lock'), F('cargo/new.lock'));
const state = (o = {}) => ({ filter: 'all', directOnly: false, query: '', collapsed: new Set(), ...o });
const shape = (rows) => rows.map((r) => (r.t === 'change' ? `  ${r.change.name}` : r.t === 'group' ? `${r.kind} ${r.count}${r.detail ? ` (${r.detail})` : ''}` : `[${r.t}] ${r.t === 'file' ? r.file.path : r.text}`));

describe('view rows', () => {
  it('one lockfile: groups by kind, no file header', () => {
    assert.deepEqual(shape(m.buildRows([npm()], state())), [
      'upgraded 6 (4 major · 2 patch)',
      '  @types/node',
      '  react',
      '  send',
      '  typescript',
      '  lodash',
      '  ms',
      'added 3',
      '  scheduler',
      '  undici-types',
      '  zod',
      'removed 1',
      '  object-assign',
      'changed 1',
      '  left-pad',
    ]);
  });

  it('several lockfiles: a header per file, and files collapse', () => {
    const files = [npm(), cargo()];
    const rows = m.buildRows(files, state({ filter: 'major' }));
    assert.deepEqual(shape(rows).slice(0, 6), ['[file] package-lock.json', 'upgraded 4 (4 major)', '  @types/node', '  react', '  send', '  typescript']);
    assert.equal(shape(rows)[6], '[file] Cargo.lock');
    assert.equal(shape(rows)[7], '[note] Format changed: Cargo.lock v3 → Cargo.lock v4.');
    assert.equal(shape(rows)[8], '[empty] Nothing matches the filter here.');
    assert.equal(rows[0].shown, 4);
    const collapsed = m.buildRows(files, state({ collapsed: new Set(['f:package-lock.json']) }));
    assert.equal(shape(collapsed)[1], '[file] Cargo.lock');
  });

  it('filters, search and direct only combine, and the counts follow', () => {
    const files = [npm()];
    const s = state({ directOnly: true, query: 'ty' });
    assert.deepEqual(
      m.buildRows(files, s).filter((r) => r.t === 'change').map((r) => r.change.name),
      ['@types/node', 'typescript'],
    );
    const counts = m.filterCounts(files, state({ directOnly: true }));
    assert.deepEqual(counts, { all: 7, major: 4, upgraded: 5, downgraded: 0, added: 1, removed: 0, changed: 1 });
  });

  it('search matches the start of a version too', () => {
    const rows = m.buildRows([npm()], state({ query: '18.' }));
    assert.deepEqual(rows.filter((r) => r.t === 'change').map((r) => r.change.name), ['@types/node', 'react']);
  });

  it('direct only is ignored for a lockfile that does not know', () => {
    const d = run('go.sum', F('go/old.sum'), F('go/new.sum'));
    assert.equal(m.buildRows([d], state({ directOnly: true })).filter((r) => r.t === 'change').length, 6);
  });

  it('collapsing a group keeps its header', () => {
    const rows = m.buildRows([npm()], state({ collapsed: new Set(['f:package-lock.json:g:upgraded']) }));
    assert.deepEqual(shape(rows).slice(0, 2), ['upgraded 6 (4 major · 2 patch)', 'added 3']);
    assert.equal(rows[0].collapsed, true);
  });

  it('notes, errors and "nothing changed" have their own rows', () => {
    const same = run('Cargo.lock', F('cargo/old.lock'), F('cargo/old.lock'));
    assert.equal(shape(m.buildRows([same], state()))[0], "[empty] The lockfile itself didn't change (6 packages).");
    const touched = run('Cargo.lock', F('cargo/old.lock'), F('cargo/old.lock') + '\n');
    assert.match(shape(m.buildRows([touched], state()))[0], /^\[empty\] No dependency changes: all 6 packages are the same/);
    const bad = run('Cargo.lock', 'nope = [', F('cargo/new.lock'));
    assert.deepEqual(shape(m.buildRows([bad], state())), [`[note] ${bad.error}`]);
    const fresh = run('Cargo.lock', undefined, F('cargo/new.lock'));
    assert.equal(shape(m.buildRows([fresh], state()))[0], '[note] New in after: every package counts as added.');
  });

  it('copy as Markdown takes what the view shows', () => {
    const vis = m.visibleChanges([npm()], state({ filter: 'added' }));
    const md = c.toMarkdown(vis);
    assert.ok(md.startsWith('### Dependency changes\n\n3 added.'));
    assert.ok(!md.includes('react'));
  });

  it('the overall line', () => {
    assert.equal(m.overall([npm(), cargo()]), '4 added, 1 removed, 9 upgraded (4 major), 2 changed');
  });
});

describe('finding a package in the lockfile', () => {
  const at = (file, name, version) => {
    const text = F(file);
    const i = c.findEntry(text, name, version);
    return text.split('\n')[i];
  };
  it('npm v3, including nested copies by version', () => {
    assert.equal(at('npm/v3/new.json', 'react', '18.2.0').trim(), '"node_modules/react": {');
    assert.equal(at('npm/v3/new.json', 'ms', '2.0.0').trim(), '"node_modules/send/node_modules/debug/node_modules/ms": {');
  });
  it('each format', () => {
    assert.equal(at('yarn/classic-new.lock', 'chalk', '5.3.0'), 'chalk@^5.3.0:');
    assert.equal(at('pnpm/v9-new.yaml', 'zod', '3.23.8'), '  zod@3.23.8:');
    assert.equal(at('cargo/new.lock', 'bitflags', '2.6.0'), 'name = "bitflags"');
    assert.equal(at('pub/new.lock', 'go_router', '14.2.7'), '  go_router:');
    assert.equal(at('ruby/new.lock', 'rack', '3.1.7'), '    rack (3.1.7)');
    assert.equal(at('go/new.mod', 'golang.org/x/sync', 'v0.7.0'), '\tgolang.org/x/sync v0.7.0 // indirect');
    assert.match(at('composer/new.lock', 'psr/log', '3.0.2'), /"name": "psr\\?\/log"/);
  });
});

describe('review fixes (round 1)', () => {
  it('multiroot-basename-collision: two repositories with one folder name get distinct labels', () => {
    const l = c.rootLabels(['/work/client/app', '/work/server/app', '/work/tools']);
    assert.deepEqual([...l.values()], ['client/app', 'server/app', 'tools']);
  });

  it('list-activedescendant-unsupported: rows carry tree level, position and set size', () => {
    const a = npm();
    const b = { ...cargo(), path: 'Cargo.lock' };
    const rows = m.buildRows([a, b], state({ collapsed: new Set(['f:Cargo.lock']) }));
    const info = m.treeInfo(rows);
    const at = (pred) => info[rows.findIndex(pred)];
    // Two files at level 1, groups at 2, changes at 3.
    assert.deepEqual(at((r) => r.t === 'file'), { level: 1, pos: 1, size: 2 });
    assert.deepEqual(at((r) => r.t === 'file' && r.file.path === 'Cargo.lock'), { level: 1, pos: 2, size: 2 });
    assert.deepEqual(at((r) => r.t === 'group' && r.kind === 'upgraded'), { level: 2, pos: 1, size: 4 });
    assert.deepEqual(at((r) => r.t === 'change' && r.change.name === 'react'), { level: 3, pos: 2, size: 6 });
  });

  it('copy-empty-selection: a search that matches nothing leaves no changes to copy', () => {
    const shown = m.visibleChanges([npm()], state({ query: 'zzz' }));
    assert.equal(shown.reduce((n, f) => n + f.changes.length, 0), 0);
  });
});
