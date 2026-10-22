# Changelog

## 0.1.1

- A comparison no longer fails when the manifest next to the lockfile exists on only one
  side (deleted or newly added). The dependency changes show as usual and the declared
  ranges read as removed or new.

## 0.1.0

First release.

- A dependency view of any lockfile change: packages added, removed, upgraded and
  downgraded, each version change marked major, minor, patch or prerelease, direct or
  transitive, with a one-line total.
- Lockfiles: `package-lock.json` and `npm-shrinkwrap.json` (v1 to v3), `yarn.lock`
  (Yarn 1 and 2+), `pnpm-lock.yaml` (5.x, 6.0, 9.0), `bun.lock`, `pubspec.lock`,
  `poetry.lock`, `uv.lock`, `Cargo.lock`, `go.mod` / `go.sum`, `composer.lock` and
  `Gemfile.lock`.
- Several versions of one package are paired into upgrades; git dependencies on a new
  commit, a new registry or a new checksum at the same version are listed too.
- `0.x` bumps follow each ecosystem's rules: breaking (and counted as major) where caret
  ranges say so (npm, Cargo, Composer, pub), marked for Go v0, literal for PEP 440 and
  RubyGems. Go pseudo-versions read as commit and date.
- npm aliases are listed under the real package, with the name they're installed as.
- Declared ranges from the manifest next to the lockfile (`package.json`, `pubspec.yaml`,
  `Cargo.toml`, `pyproject.toml`, `composer.json`, `Gemfile`): the range change on each
  direct dependency, and a warning when the lockfile wasn't updated, misses a declared
  dependency, or has a version outside the new range.
- Branch comparisons start at the merge base, as a pull request diff does, with a switch
  to tip to tip (when one side contains the other, the tips are compared); **Show Dependency Changes on This Branch** compares with the default
  branch in one step.
- **Lockfile History**: the commits that changed a lockfile, each with a one-line summary
  of its dependency changes, opening in one view tab that each click reuses.
- Compare the working tree with HEAD, the two sides of any diff editor, a branch, tag or
  commit, two revisions, or two files; one lockfile or every changed lockfile at once.
- Buttons in the editor title and Source Control title, and entries in the Explorer and
  Source Control context menus.
- Filters, search (by name, or version as shown), direct-only, registry links, go to the entry in the lockfile, the
  text diff, and Copy as Markdown for pull requests.
- The view follows the working tree and the index (recomputing only when HEAD, the index,
  a compared branch, or a lockfile or manifest changed, and not while hidden), and comes back after a window
  reload.
- In Restricted Mode, Git isn't run; comparing two files or a diff editor still works.
