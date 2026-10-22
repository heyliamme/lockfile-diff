import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lines, run } from './helpers.mjs';

const json = (o) => JSON.stringify(o, null, 2);

describe('review fixes (round 4)', () => {
  it('a manifest missing on one side keeps the diff (no crash)', () => {
    const lock = (v) => json({ lockfileVersion: 3, packages: { '': { dependencies: { x: '^1.0.0' } }, 'node_modules/x': { version: v } } });
    const pkg = json({ dependencies: { x: '^1.0.0' } });
    // Deleted on the right: the declared range reads as removed, the lockfile diff stays.
    const gone = run('package-lock.json', lock('1.0.0'), lock('1.1.0'), { 'package.json': pkg }, { 'package.json': undefined });
    assert.equal(gone.error, undefined);
    assert.deepEqual(lines(gone), ['upgraded minor x 1.0.0->1.1.0 D']);
    assert.deepEqual(gone.manifest.ranges, [{ name: 'x', from: '^1.0.0', to: undefined, dev: undefined }]);
    assert.equal(gone.warnings, undefined);
    // Added on the right: same, the other way.
    const added = run('package-lock.json', lock('1.0.0'), lock('1.1.0'), { 'package.json': undefined }, { 'package.json': pkg });
    assert.equal(added.error, undefined);
    assert.deepEqual(lines(added), ['upgraded minor x 1.0.0->1.1.0 D']);
    assert.deepEqual(added.manifest.ranges, [{ name: 'x', from: undefined, to: '^1.0.0', dev: undefined }]);
  });
});
