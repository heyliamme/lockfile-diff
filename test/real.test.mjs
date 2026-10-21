import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { F, lines, run, summary } from './helpers.mjs';

// Lockfiles written by the real tools (versions in each case's title), before and after an
// upgrade: a major, a 0.x minor, a patch, a dev dependency, one added and one removed, plus
// what each format is known for (npm aliases, Yarn 2+ workspaces with portal: and link:,
// pnpm 5 tarball keys, Bun git dependencies, Go pseudo-versions and a /v2 module path).

const pair = (dir, lock, manifest, as) => {
  const r = (side, f) => F(`real/${dir}/${side}.${f}`);
  return run(as ?? lock, r('old', lock), r('new', lock), { [manifest]: r('old', manifest) }, { [manifest]: r('new', manifest) });
};

describe('real lockfiles', () => {
  it("npm 11: package-lock.json", () => {
    const d = pair("npm", "package-lock.json", "package.json");
    assert.equal(d.format, "package-lock.json v3");
    assert.equal(summary(d), "2 added, 2 removed, 8 upgraded (6 major)");
    assert.equal(d.warnings, undefined);
    assert.deepEqual(lines(d), [
      "upgraded major ansi-regex 5.0.1->6.4.0 t",
      "upgraded major emoji-regex 8.0.0->9.2.2 t",
      "upgraded major escape-string-regexp 4.0.0->5.0.0 D",
      "upgraded major picocolors 0.1.0->0.2.1 D",
      "upgraded major string-width 4.2.3->5.1.2 D",
      "upgraded major strip-ansi 6.0.1->7.2.0 t",
      "upgraded minor left-pad 1.2.0->1.3.0 D dev",
      "upgraded patch ms 2.1.2->2.1.3 D",
      "added eastasianwidth ->0.2.0 t",
      "added tiny-invariant ->1.3.3 D",
      "removed is-fullwidth-code-point 3.0.0-> t",
      "removed isarray 2.0.5-> D",
    ]);
  });
  it("Yarn 1.22: yarn.lock", () => {
    const d = pair("yarn-classic", "yarn.lock", "package.json");
    assert.equal(d.format, "yarn.lock (Yarn 1)");
    assert.equal(summary(d), "2 added, 2 removed, 8 upgraded (6 major)");
    assert.equal(d.warnings, undefined);
    assert.deepEqual(lines(d), [
      "upgraded major ansi-regex 5.0.1->6.4.0 t",
      "upgraded major emoji-regex 8.0.0->9.2.2 t",
      "upgraded major escape-string-regexp 4.0.0->5.0.0 D",
      "upgraded major picocolors 0.1.0->0.2.1 D",
      "upgraded major string-width 4.2.3->5.1.2 D",
      "upgraded major strip-ansi 6.0.1->7.2.0 t",
      "upgraded minor left-pad 1.2.0->1.3.0 D dev",
      "upgraded patch ms 2.1.2->2.1.3 D",
      "added eastasianwidth ->0.2.0 t",
      "added tiny-invariant ->1.3.3 D",
      "removed is-fullwidth-code-point 3.0.0-> t",
      "removed isarray 2.0.5-> D",
    ]);
  });
  it("Yarn 4.5 (workspace, portal:, link:): yarn.lock", () => {
    const d = pair("yarn-berry", "yarn.lock", "package.json");
    assert.equal(d.format, "yarn.lock (Yarn 2+, v8)");
    assert.equal(summary(d), "2 added, 2 removed, 8 upgraded (6 major)");
    assert.equal(d.warnings, undefined);
    assert.deepEqual(lines(d), [
      "upgraded major ansi-regex 5.0.1->6.4.0 t",
      "upgraded major emoji-regex 8.0.0->9.2.2 t",
      "upgraded major escape-string-regexp 4.0.0->5.0.0 D",
      "upgraded major picocolors 0.1.0->0.2.1 D",
      "upgraded major string-width 4.2.3->5.1.2 D",
      "upgraded major strip-ansi 6.0.1->7.2.0 t",
      "upgraded minor left-pad 1.2.0->1.3.0 D dev",
      "upgraded patch ms 2.1.2->2.1.3 D",
      "added eastasianwidth ->0.2.0 t",
      "added tiny-invariant ->1.3.3 D",
      "removed is-fullwidth-code-point 3.0.0-> t",
      "removed isarray 2.0.5-> D",
    ]);
  });
  it("pnpm 11 (lockfile 9.0, workspace): pnpm-lock.yaml", () => {
    const d = pair("pnpm9", "pnpm-lock.yaml", "package.json");
    assert.equal(d.format, "pnpm-lock.yaml 9.0");
    assert.equal(summary(d), "2 added, 2 removed, 8 upgraded (6 major)");
    assert.equal(d.warnings, undefined);
    assert.deepEqual(lines(d), [
      "upgraded major ansi-regex 5.0.1->6.4.0 t",
      "upgraded major emoji-regex 8.0.0->9.2.2 t",
      "upgraded major escape-string-regexp 4.0.0->5.0.0 D",
      "upgraded major picocolors 0.1.0->0.2.1 D",
      "upgraded major string-width 4.2.3->5.1.2 D",
      "upgraded major strip-ansi 6.0.1->7.2.0 t",
      "upgraded minor left-pad 1.2.0->1.3.0 D dev",
      "upgraded patch ms 2.1.2->2.1.3 D",
      "added eastasianwidth ->0.2.0 t",
      "added tiny-invariant ->1.3.3 D",
      "removed is-fullwidth-code-point 3.0.0-> t",
      "removed isarray 2.0.5-> D",
    ]);
  });
  it("pnpm 7 (lockfile 5.4, tarball and github deps): pnpm-lock.yaml", () => {
    const d = pair("pnpm5", "pnpm-lock.yaml", "package.json");
    assert.equal(d.format, "pnpm-lock.yaml 5.4");
    assert.equal(summary(d), "2 added, 2 removed, 11 upgraded (8 major)");
    assert.equal(d.warnings, undefined);
    assert.deepEqual(lines(d), [
      "upgraded major ansi-regex 5.0.1->6.4.0 t",
      "upgraded major emoji-regex 8.0.0->9.2.2 t",
      "upgraded major escape-string-regexp 4.0.0->5.0.0 D",
      "upgraded major is-number 6.0.0->7.0.0 D",
      "upgraded major is-plain-obj 3.0.0@d41fca4->4.1.0@3b33a59 D",
      "upgraded major picocolors 0.1.0->0.2.1 D",
      "upgraded major string-width 4.2.3->5.1.2 D",
      "upgraded major strip-ansi 6.0.1->7.2.0 t",
      "upgraded minor left-pad 1.2.0->1.3.0 D dev",
      "upgraded patch kind-of 6.0.2->6.0.3 D",
      "upgraded patch ms 2.1.2->2.1.3 D",
      "added eastasianwidth ->0.2.0 t",
      "added tiny-invariant ->1.3.3 D",
      "removed is-fullwidth-code-point 3.0.0-> t",
      "removed isarray 2.0.5-> D",
    ]);
  });
  it("pnpm 6 (lockfile 5.3): pnpm-lock.v5.3.yaml", () => {
    const d = pair("pnpm5", "pnpm-lock.v5.3.yaml", "package.json", "pnpm-lock.yaml");
    assert.equal(d.format, "pnpm-lock.yaml 5.3");
    assert.equal(summary(d), "2 added, 2 removed, 11 upgraded (8 major)");
    assert.equal(d.warnings, undefined);
    assert.deepEqual(lines(d), [
      "upgraded major ansi-regex 5.0.1->6.4.0 t",
      "upgraded major emoji-regex 8.0.0->9.2.2 t",
      "upgraded major escape-string-regexp 4.0.0->5.0.0 D",
      "upgraded major is-number 6.0.0->7.0.0 D",
      "upgraded major is-plain-obj 3.0.0@d41fca4->4.1.0@3b33a59 D",
      "upgraded major picocolors 0.1.0->0.2.1 D",
      "upgraded major string-width 4.2.3->5.1.2 D",
      "upgraded major strip-ansi 6.0.1->7.2.0 t",
      "upgraded minor left-pad 1.2.0->1.3.0 D dev",
      "upgraded patch kind-of 6.0.2->6.0.3 D",
      "upgraded patch ms 2.1.2->2.1.3 D",
      "added eastasianwidth ->0.2.0 t",
      "added tiny-invariant ->1.3.3 D",
      "removed is-fullwidth-code-point 3.0.0-> t",
      "removed isarray 2.0.5-> D",
    ]);
  });
  it("Bun 1.2 (git deps): bun.lock", () => {
    const d = pair("bun", "bun.lock", "package.json");
    assert.equal(d.format, "bun.lock v1");
    assert.equal(summary(d), "2 added, 2 removed, 8 upgraded (6 major), 2 changed");
    assert.equal(d.warnings, undefined);
    assert.deepEqual(lines(d), [
      "upgraded major ansi-regex 5.0.1->6.4.0 t",
      "upgraded major emoji-regex 8.0.0->9.2.2 t",
      "upgraded major escape-string-regexp 4.0.0->5.0.0 D",
      "upgraded major picocolors 0.1.0->0.2.1 D",
      "upgraded major string-width 4.2.3->5.1.2 D",
      "upgraded major strip-ansi 6.0.1->7.2.0 t",
      "upgraded minor left-pad 1.2.0->1.3.0 D dev",
      "upgraded patch ms 2.1.2->2.1.3 D",
      "added eastasianwidth ->0.2.0 t",
      "added tiny-invariant ->1.3.3 D",
      "removed is-fullwidth-code-point 3.0.0-> t",
      "removed isarray 2.0.5-> D",
      "changed is-number @b095363->@98e8ff1 D",
      "changed is-plain-obj @d41fca4->@3b33a59 D",
    ]);
  });
  it("Bun 1.4 (lockfile v2): bun.v2.lock", () => {
    const d = pair("bun", "bun.v2.lock", "package.json", "bun.lock");
    assert.equal(d.format, "bun.lock v2");
    assert.equal(summary(d), "2 added, 2 removed, 8 upgraded (6 major), 2 changed");
    assert.equal(d.warnings, undefined);
    assert.deepEqual(lines(d), [
      "upgraded major ansi-regex 5.0.1->6.4.0 t",
      "upgraded major emoji-regex 8.0.0->9.2.2 t",
      "upgraded major escape-string-regexp 4.0.0->5.0.0 D",
      "upgraded major picocolors 0.1.0->0.2.1 D",
      "upgraded major string-width 4.2.3->5.1.2 D",
      "upgraded major strip-ansi 6.0.1->7.2.0 t",
      "upgraded minor left-pad 1.2.0->1.3.0 D dev",
      "upgraded patch ms 2.1.2->2.1.3 D",
      "added eastasianwidth ->0.2.0 t",
      "added tiny-invariant ->1.3.3 D",
      "removed is-fullwidth-code-point 3.0.0-> t",
      "removed isarray 2.0.5-> D",
      "changed is-number @b095363->@98e8ff1 D",
      "changed is-plain-obj @d41fca4->@3b33a59 D",
    ]);
  });
  it("Cargo 1.99 (git dep, dev-dependency): Cargo.lock", () => {
    const d = pair("cargo", "Cargo.lock", "Cargo.toml");
    assert.equal(d.format, "Cargo.lock v4");
    assert.equal(summary(d), "1 added, 1 removed, 5 upgraded (2 major)");
    assert.equal(d.warnings, undefined);
    assert.deepEqual(lines(d), [
      "upgraded major hex 0.3.2->0.4.3 D",
      "upgraded major itoa 0.4.8->1.0.18 D",
      "upgraded minor byteorder 1.4.3@abffade->1.5.0@ec068ee D",
      "upgraded minor either 1.8.0->1.19.0 D dev",
      "upgraded patch cfg-if 1.0.0->1.0.5 D",
      "added memchr ->2.8.3 D",
      "removed lazy_static 1.5.1-> D",
    ]);
  });
  it("Poetry 2.5 (lock 2.1): poetry.lock", () => {
    const d = pair("poetry", "poetry.lock", "pyproject.toml");
    assert.equal(d.format, "poetry.lock 2.1");
    assert.equal(summary(d), "1 added, 1 removed, 4 upgraded (2 major)");
    assert.equal(d.warnings, undefined);
    assert.deepEqual(lines(d), [
      "upgraded major attrs 22.2.0->26.1.0 D",
      "upgraded major iniconfig 1.1.1->2.0.0 D dev",
      "upgraded minor idna 3.4->3.10 D",
      "upgraded minor toml 0.9.6->0.10.2 D",
      "added packaging ->24.2 D",
      "removed six 1.16.0-> D",
    ]);
  });
  it("uv 0.13: uv.lock", () => {
    const d = pair("uv", "uv.lock", "pyproject.toml");
    assert.equal(d.format, "uv.lock v1");
    assert.equal(summary(d), "1 added, 1 removed, 4 upgraded (2 major)");
    assert.equal(d.warnings, undefined);
    assert.deepEqual(lines(d), [
      "upgraded major attrs 22.2.0->26.1.0 D",
      "upgraded major iniconfig 1.1.1->2.0.0 D dev",
      "upgraded minor idna 3.4->3.10 D",
      "upgraded minor toml 0.9.6->0.10.2 D",
      "added packaging ->24.2 D",
      "removed six 1.16.0-> D",
    ]);
  });
  it("Composer 2.10: composer.lock", () => {
    const d = pair("composer", "composer.lock", "composer.json");
    assert.equal(d.format, "composer.lock");
    assert.equal(summary(d), "1 added, 1 removed, 4 upgraded (2 major)");
    assert.equal(d.warnings, undefined);
    assert.deepEqual(lines(d), [
      "upgraded major brick/math 0.10.2->0.11.0 D",
      "upgraded major psr/log 1.1.4->3.0.2 D",
      "upgraded minor psr/http-message 1.0.1->1.1 D dev",
      "upgraded minor symfony/polyfill-ctype v1.26.0->v1.37.0 D",
      "added psr/clock ->1.0.0 D",
      "removed psr/simple-cache 1.0.1-> D",
    ]);
  });
  it("Bundler 2.5 (git gem): Gemfile.lock", () => {
    const d = pair("bundler", "Gemfile.lock", "Gemfile");
    assert.equal(d.format, "Gemfile.lock");
    assert.equal(summary(d), "1 added, 1 removed, 5 upgraded (1 major)");
    assert.equal(d.warnings, undefined);
    assert.deepEqual(lines(d), [
      "upgraded major rack 2.2.8->3.2.7 D",
      "upgraded minor base64 0.1.2->0.2.0 D",
      "upgraded minor minitest 5.15.0->5.27.0 D dev",
      "upgraded minor rake 13.0.6->13.4.2 D",
      "upgraded patch abbrev 0.1.1@691bcf1->0.1.2@7bc28a4 D",
      "added logger ->1.7.0 D",
      "removed ostruct 0.5.5-> D",
    ]);
  });
  it("Go 1.27 (pseudo-versions, /v2): go.sum", () => {
    const d = pair("go", "go.sum", "go.mod");
    assert.equal(d.format, "go.mod");
    assert.equal(summary(d), "2 added, 2 removed, 6 upgraded");
    assert.equal(d.warnings, undefined);
    assert.deepEqual(lines(d), [
      "upgraded minor github.com/google/go-cmp v0.5.9->v0.6.0 D",
      "upgraded minor github.com/google/uuid v1.3.0->v1.6.0 D",
      "upgraded minor github.com/pkg/errors v0.8.1->v0.9.1 D",
      "upgraded minor golang.org/x/sys v0.1.0->v0.6.0 t",
      "upgraded patch github.com/mattn/go-isatty v0.0.16->v0.0.20 D",
      "upgraded other golang.org/x/exp v0.0.0-20230801115018-d63ba01acd4b->v0.0.0-20261014143641-f0251eb4aa3e D",
      "added github.com/cespare/xxhash/v2 ->v2.3.0 D",
      "added github.com/pmezard/go-difflib ->v1.0.0 D",
      "removed github.com/cespare/xxhash v1.1.0-> D",
      "removed github.com/davecgh/go-spew v1.1.1-> D",
    ]);
  });
  it("Dart 3.11 pub: pubspec.lock", () => {
    const d = pair("dart", "pubspec.lock", "pubspec.yaml");
    assert.equal(d.format, "pubspec.lock");
    assert.equal(summary(d), "2 added, 2 removed, 4 upgraded (3 major)");
    assert.equal(d.warnings, undefined);
    assert.deepEqual(lines(d), [
      "upgraded major js 0.6.7->0.7.2 D",
      "upgraded major lints 2.1.1->5.1.1 D dev",
      "upgraded major uuid 3.0.7->4.6.0 D",
      "upgraded minor path 1.8.3->1.9.1 D",
      "added characters ->1.4.1 D",
      "added fixnum ->1.1.1 t",
      "removed meta 1.19.0-> t",
      "removed term_glyph 1.2.1-> D",
    ]);
  });
});

describe('real lockfiles: details', () => {
  it('aliases resolve to string-width in every npm-family format, installed as cjs-sw', () => {
    for (const [dir, lock, as] of [['npm', 'package-lock.json'], ['yarn-classic', 'yarn.lock'], ['yarn-berry', 'yarn.lock'], ['pnpm9', 'pnpm-lock.yaml'], ['pnpm5', 'pnpm-lock.yaml'], ['bun', 'bun.lock'], ['bun', 'bun.v2.lock', 'bun.lock']]) {
      const c = pair(dir, lock, 'package.json', as).changes.find((x) => x.name === 'string-width');
      assert.equal(c.alias, 'cjs-sw', dir);
      assert.deepEqual(c.range, { from: 'npm:string-width@^4.2.3', to: 'npm:string-width@^5.1.2' }, dir);
    }
  });
  it('Yarn 2+: workspace, portal: and link: entries are not packages from a registry', () => {
    const d = pair('yarn-berry', 'yarn.lock', 'package.json');
    assert.ok(!d.changes.some((c) => /^(@lf\/|local-)/.test(c.name)));
    assert.equal(d.error, undefined);
  });
  it('pnpm 5: a tarball key reads its name and version from the entry; github deps by commit', () => {
    const d = pair('pnpm5', 'pnpm-lock.yaml', 'package.json');
    assert.equal(lines(d).find((l) => l.includes('kind-of')), 'upgraded patch kind-of 6.0.2->6.0.3 D');
    assert.equal(lines(d).find((l) => l.includes('is-plain-obj')), 'upgraded major is-plain-obj 3.0.0@d41fca4->4.1.0@3b33a59 D');
  });
  it('Bun: git dependencies are compared by commit', () => {
    const d = pair('bun', 'bun.lock', 'package.json');
    assert.deepEqual(
      d.changes.filter((c) => c.kind === 'changed').map((c) => `${c.name} ${c.from}->${c.to} ${c.note ?? ''}`),
      ['is-number @b095363->@98e8ff1 ', 'is-plain-obj @d41fca4->@3b33a59 '],
    );
  });
  it('Go: a pseudo-version bump is a commit change; a /v2 path is the next major', () => {
    const d = pair('go', 'go.sum', 'go.mod');
    const exp = d.changes.find((c) => c.name === 'golang.org/x/exp');
    assert.equal(exp.why, 'commit d63ba01 (2023-08-01) → commit f0251eb (2026-10-14)');
    assert.equal(d.changes.find((c) => c.name === 'github.com/cespare/xxhash/v2').note, 'new major version of github.com/cespare/xxhash (v1.1.0 removed)');
  });
  it('Cargo and Bundler: dev dependencies come from the manifest', () => {
    assert.equal(pair('cargo', 'Cargo.lock', 'Cargo.toml').changes.find((c) => c.name === 'either').dev, true);
    assert.equal(pair('bundler', 'Gemfile.lock', 'Gemfile').changes.find((c) => c.name === 'minitest').dev, true);
  });
});
