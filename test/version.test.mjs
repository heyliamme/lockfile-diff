import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { c } from './helpers.mjs';

const mv = (a, b) => {
  const m = c.movement(a, b);
  return `${m.direction > 0 ? 'up' : m.direction < 0 ? 'down' : 'same'} ${m.bump}`;
};

describe('movement', () => {
  const cases = [
    ['1.4.2', '2.0.0', 'up major'],
    ['1.4.2', '1.5.0', 'up minor'],
    ['1.4.2', '1.4.3', 'up patch'],
    ['2.0.0', '1.9.9', 'down major'],
    ['1.4.3', '1.4.2', 'down patch'],
    ['2.0.0-rc.1', '2.0.0', 'up prerelease'],
    ['2.0.0-beta.2', '2.0.0-beta.10', 'up prerelease'],
    ['2.0.0-alpha.1', '2.0.0-beta.1', 'up prerelease'],
    ['2.0.0', '2.0.0-rc.1', 'down prerelease'],
    ['1.4.2', '1.4.3-rc.1', 'up patch'],
    ['18.2.0', '19.0.0-rc.1', 'up major'],
    ['0.23.0', '0.24.0', 'up minor'], // literal position; 0.x isn't promoted to major
    ['v1.2.3', 'v1.3.0', 'up minor'],
    ['v2.0.0+incompatible', 'v2.1.0+incompatible', 'up minor'],
    ['v0.0.0-20221227161230-091c0ba34f0a', 'v0.0.0-20240606120523-5a60cdf6a761', 'up prerelease'],
    ['1.0', '1.0.1', 'up patch'],
    ['3.6', '3.7', 'up minor'],
    ['8.2.0rc1', '8.2.0', 'up prerelease'],
    ['1.0a1', '1.0b1', 'up prerelease'],
    ['1.0', '1.0.post1', 'up patch'],
    ['1!1.0', '2.0', 'down major'],
    ['7.0.8', '7.1.3.4', 'up minor'],
    ['7.1.3.3', '7.1.3.4', 'up patch'],
    ['1.2.0.pre1', '1.2.0', 'up prerelease'],
    ['v1.2.3-RC1', 'v1.2.3', 'up prerelease'],
    ['2024.2.2', '2024.8.30', 'up minor'],
    ['1.3.0@2fca615', '1.3.0@9e1ab8b', 'same other'],
    ['1.0.0@3b2c9d0', '1.1.0@8f7e6d5', 'up minor'],
    ['2fca615', '9e1ab8b', 'same other'],
    ['dev-main#abc1234', 'dev-main#def5678', 'same other'],
    ['github:a/b', '1.0.0', 'same other'],
    ['1.0.0', '1.0.0', 'same other'],
  ];
  for (const [a, b, want] of cases) it(`${a} -> ${b}: ${want}`, () => assert.equal(mv(a, b), want));
});

describe('compareVersions', () => {
  it('orders like a person would', () => {
    const list = ['1.10.0', '1.2.0', '1.2.0-rc.1', '1.2.0-beta.11', '1.2.0-beta.2', '0.9', '2.0.0', '1.2.0.post1', 'not-a-version'];
    assert.deepEqual([...list].sort(c.compareVersions), ['0.9', '1.2.0-beta.2', '1.2.0-beta.11', '1.2.0-rc.1', '1.2.0', '1.2.0.post1', '1.10.0', '2.0.0', 'not-a-version']);
  });

  it('keeps huge numeric identifiers exact enough to order', () => {
    assert.ok(c.compareVersions('0.0.0-20240606120523', '0.0.0-20221227161230') > 0);
  });

  it('isPrerelease', () => {
    assert.equal(c.isPrerelease('1.0.0-rc.1'), true);
    assert.equal(c.isPrerelease('8.2.0rc1'), true);
    assert.equal(c.isPrerelease('1.0.0'), false);
    assert.equal(c.isPrerelease('1.0.post1'), false);
  });
});

describe('registry links', () => {
  it('builds each registry page, keeping scopes and module paths readable', () => {
    assert.equal(c.registryUrl('npm', '@types/node', '20.12.7'), 'https://www.npmjs.com/package/@types/node/v/20.12.7');
    assert.equal(c.registryUrl('cargo', 'serde', '1.0.210'), 'https://crates.io/crates/serde/1.0.210');
    assert.equal(c.registryUrl('go', 'github.com/a/b/v5', 'v5.1.0'), 'https://pkg.go.dev/github.com/a/b/v5@v5.1.0');
    assert.equal(c.registryUrl('rubygems', 'rack'), 'https://rubygems.org/gems/rack');
  });

  it('never links odd names, and only allows its own hosts', () => {
    assert.equal(c.registryUrl('npm', 'a"><script>'), undefined);
    assert.equal(c.registryUrl('packagist', 'no-slash'), undefined);
    assert.equal(c.isRegistryUrl('https://www.npmjs.com/package/x'), true);
    assert.equal(c.isRegistryUrl('http://www.npmjs.com/package/x'), false);
    assert.equal(c.isRegistryUrl('https://evil.example/x'), false);
    assert.equal(c.isRegistryUrl('https://a:b@pypi.org/'), false);
    assert.equal(c.isRegistryUrl('javascript:alert(1)'), false);
  });
});
