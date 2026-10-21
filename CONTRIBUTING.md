# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an issue with the lockfile format (for example "pnpm-lock.yaml, lockfileVersion
9.0"), the entries involved before and after, what you expected and what you saw. The
output of **Copy as Markdown** helps. Redact private registry URLs.

## Running from source

Node 22 or newer.

```bash
git clone https://github.com/heyliamme/lockfile-diff
cd lockfile-diff
npm install
npm run watch        # rebuilds dist/ on change
```

Then press `F5` in VS Code to start an Extension Development Host with the extension
loaded.

## Tests

```bash
npm run typecheck
npm test
```

- `test/parsers.test.mjs` runs every parser on the realistic lockfiles in
  `test/fixtures/` and checks the full list of changes, plus junk input for each format.
- `test/version.test.mjs` covers version ordering and major/minor/patch across semver,
  PEP 440, RubyGems, Go and Composer, and the registry links.
- `test/diff.test.mjs` covers pairing several versions of one package, sorting, counts,
  the Markdown summary, excludes and comparing across formats.
- `test/yaml.test.mjs` checks that the fast lockfile YAML reader agrees with a full YAML
  parser on every fixture, and hands over what it doesn't handle.
- `test/model.test.mjs` covers the view's grouping, filters and search, and finding a
  package's entry in a lockfile.
- `test/real.test.mjs` runs the lockfiles in `test/fixtures/real/`, written by the real
  tools (npm 11, Yarn 1.22 and 4.5, pnpm 6, 7 and 11, Bun 1.2 and 1.4, Cargo, Poetry, uv,
  Composer, Bundler, Go, Dart) before and after an upgrade, with their manifests.
  Regenerate them with the tool when a format changes; don't edit them by hand.
- `test/features.test.mjs` covers `0.x` rules per ecosystem, Go pseudo-versions, declared
  ranges and manifests, and npm aliases.
- `test/perf.test.mjs` compares lockfiles of 50,000 packages within a time budget.

A new lockfile format needs a parser in `src/core/parsers/`, an entry in
`src/core/detect.ts`, the file name in `package.json` (menus) and `src/panel.ts`
(the file watcher), and before/after fixtures with a test.

## End-to-end tests

`test/e2e/run.mjs` installs the packaged extension into a throwaway VS Code profile,
builds a Git repository with commits, a tag, staged and unstaged lockfile changes, and
uses the extension as a person would: title buttons, the Source Control view and its
context menu, quick picks, the clipboard, every control in the view, a window reload,
and a second window in Restricted Mode. VS Code runs headless, so it doesn't take over
your screen. Linux only (it uses Chromium's headless mode), with `code` on your `PATH`
(or set `VSCODE_CLI` and `VSCODE_BIN`):

```bash
npm run test:e2e
E2E_SHOTS=images node test/e2e/run.mjs    # also retakes the README screenshots
```

Screenshots of failing steps land in the temporary folder it prints.

## Layout

| Path | |
| --- | --- |
| `src/core/parsers/` | One parser per lockfile format, all behind `LockParser` |
| `src/core/version.ts` | Version ordering and major/minor/patch |
| `src/core/diff.ts` | The dependency diff |
| `src/core/analyze.ts` | One lockfile across two sides, errors included |
| `src/core/yaml.ts` | The fast reader for lockfile YAML |
| `src/core/markdown.ts` | The summary line and Copy as Markdown |
| `src/git.ts` | Git, through the built-in Git extension or `git` itself |
| `src/comparison.ts` | What to compare, and running it |
| `src/panel.ts` | The webview panel, refreshes, links |
| `src/extension.ts` | Commands and pickers |
| `webview/model.ts` | Grouping and filtering into rows |
| `webview/main.ts` | The view's UI |

`src/core` has no `vscode` import, so all of it runs under `node --test`.

## Pull requests

- Keep each PR to one change, and say why in the description.
- Run `npm run typecheck` and `npm test`.
- For UI changes, include screenshots in light and dark themes.

Maintainers: see [RELEASING.md](RELEASING.md) for how releases are published.

By contributing you agree that your contribution is licensed under the MIT license.
