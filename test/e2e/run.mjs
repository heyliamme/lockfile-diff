// End-to-end: installs the packaged extension into a throwaway VS Code profile, opens a
// workspace with lockfiles in a fresh git repository (commits, a tag, staged and unstaged
// changes), and uses the extension the way a person would: title buttons, the Source
// Control view, quick picks, the clipboard, and every control in the view. Linux, with
// `code` on PATH.
//
//   npm run package && node test/e2e/run.mjs [lockfile-diff-x.y.z.vsix]
//   E2E_SHOTS=images node test/e2e/run.mjs   # also writes the README screenshots there
import { execFileSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { VSCode, waitFor } from './vscode.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const vsix = path.resolve(process.argv[2] || `${pkg.name}-${pkg.version}.vsix`);
if (!existsSync(vsix)) throw new Error(`${vsix} not found: run npm run package first`);
const shotsFor = process.env.E2E_SHOTS ? path.resolve(process.env.E2E_SHOTS) : undefined;

const fx = (p) => path.resolve('test/fixtures', p);
const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'lockfile-diff-e2e-')));
const ws = path.join(root, 'workspace');
const out = path.join(root, 'shots');
mkdirSync(out);
const put = (rel, from) => {
  mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  copyFileSync(from, path.join(ws, rel));
};
const write = (rel, text) => writeFileSync(path.join(ws, rel), text);

// The repository: a web app (npm), a Flutter app (pub), a Rust tool (Cargo) and two yarn
// lockfiles to compare with each other.
// package.json declares what each side of the npm fixture resolves.
const manifest = (side) => JSON.stringify({ name: 'storefront', version: '1.4.0', private: true, ...Object.fromEntries(['dependencies', 'devDependencies'].map((k) => [k, JSON.parse(readFileSync(fx(`npm/v3/${side}.json`), 'utf8')).packages[''][k]])) }, null, 2) + '\n';
put('web/package-lock.json', fx('npm/v3/old.json'));
write('web/package.json', manifest('old'));
// Cargo.toml for the "manifest changed, lockfile didn't" case.
const cargoToml = (clap) => `[package]\nname = "tiny-cli"\nversion = "0.3.0"\n\n[dependencies]\nclap = "${clap}"\nserde = "1"\n`;
write('Cargo.toml', cargoToml('4'));
// Loose files to compare with each other: Go pseudo-versions, and an npm alias.
put('compare/go-old/go.mod', fx('go/old.mod'));
put('compare/go-new/go.mod', fx('go/new.mod'));
const aliasLock = (v) => JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': { dependencies: { 'string-width-cjs': `npm:string-width@^${v[0]}` } }, 'node_modules/string-width-cjs': { name: 'string-width', version: v } } }, null, 2) + '\n';
mkdirSync(path.join(ws, 'compare/alias-old'), { recursive: true });
mkdirSync(path.join(ws, 'compare/alias-new'), { recursive: true });
write('compare/alias-old/package-lock.json', aliasLock('4.2.3'));
write('compare/alias-new/package-lock.json', aliasLock('5.1.2'));
put('app/pubspec.lock', fx('pub/old.lock'));
put('Cargo.lock', fx('cargo/old.lock'));
put('compare/old/yarn.lock', fx('yarn/classic-old.lock'));
put('compare/new/yarn.lock', fx('yarn/classic-new.lock'));
writeFileSync(path.join(root, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
const git = (...a) => execFileSync('git', a, { cwd: ws, encoding: 'utf8' });
git('init', '-q');
git('add', '.');
git('commit', '-qm', 'Initial lockfiles');
git('tag', 'v1.0.0');
git('branch', 'release-1.0');
// A branch off v1.0.0 that upgrades the web app, while main bumps crates: the histories diverge.
git('checkout', '-q', '-b', 'deps/web');
put('web/package-lock.json', fx('npm/v3/new.json'));
write('web/package.json', manifest('new'));
git('commit', '-qam', 'Upgrade web dependencies');
git('checkout', '-q', 'main');
put('Cargo.lock', fx('cargo/new.lock'));
git('commit', '-qam', 'Bump crates');
// Staged: the pubspec.lock upgrade. Unstaged: the package-lock.json upgrade.
put('app/pubspec.lock', fx('pub/new.lock'));
git('add', 'app/pubspec.lock');
put('web/package-lock.json', fx('npm/v3/new.json'));
write('web/package.json', manifest('new'));

const settings = {
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none',
  'workbench.colorTheme': 'Default Dark Modern',
  'window.restoreWindows': 'none',
  'window.titleBarStyle': 'custom',
  'window.menuStyle': 'custom',
  'git.openRepositoryInParentFolders': 'never',
  'git.autoRepositoryDetection': true,
  'extensions.autoUpdate': false,
  'telemetry.telemetryLevel': 'off',
  'chat.disableAIFeatures': true,
  'window.dialogStyle': 'custom',
  'workbench.tips.enabled': false,
  'editor.minimap.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'scm.defaultViewMode': 'list',
};
// `let`: the Restricted Mode steps at the end drive a second window.
let vs = new VSCode(root);
vs.install(vsix, settings);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failed = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    if (await vs.quickInputVisible().catch(() => false)) await vs.key('Escape');
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    failed.push(name);
    const file = path.join(out, `${failed.length}-${name.replace(/\W+/g, '-')}.png`);
    await vs.screenshot(file).catch(() => {});
    console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}\n      screenshot: ${file}`);
  }
}
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// In the webview.
const W = {
  summary: `document.getElementById('summaryText')?.textContent ?? ''`,
  title: `document.getElementById('title').textContent`,
  range: `[...document.querySelectorAll('#range .side')].map((e) => e.textContent)`,
  status: `document.getElementById('status').textContent`,
  // Every row of the (virtualized) list, from the model the view draws.
  names: `[...document.querySelectorAll('#rows .row.change .name')].map((e) => e.textContent)`,
  groups: `[...document.querySelectorAll('#rows .row.group')].map((e) => e.querySelector('.glabel').textContent + ' ' + e.querySelector('.gcount').textContent)`,
  files: `[...document.querySelectorAll('#rows .row.file .fname')].map((e) => e.textContent)`,
  notes: `[...document.querySelectorAll('#rows .row.note, #rows .row.empty')].map((e) => e.textContent)`,
  filter: (f) => `(() => { const b = document.querySelector('[data-filter="${f}"]'); if (!b) throw new Error('no filter ${f}'); b.click(); return true; })()`,
  filterCount: (f) => `document.querySelector('[data-filter="${f}"] .count')?.textContent`,
  click: (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('not found: ' + ${JSON.stringify(sel)}); e.click(); return true; })()`,
  rowAct: (name, act) => `(() => { const r = [...document.querySelectorAll('#rows .row.change')].find((r) => r.querySelector('.name').textContent === ${JSON.stringify(name)}); if (!r) throw new Error('no row ' + ${JSON.stringify(name)}); r.querySelector('[data-act="${act}"]').click(); return true; })()`,
  rowText: (name, sel) => `[...document.querySelectorAll('#rows .row.change')].find((r) => r.querySelector('.name').firstChild.textContent === ${JSON.stringify(name)})?.querySelector(${JSON.stringify(sel)})?.textContent ?? null`,
  rowAttr: (name, sel, attr) => `[...document.querySelectorAll('#rows .row.change')].find((r) => r.querySelector('.name').firstChild.textContent === ${JSON.stringify(name)})?.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(attr)}) ?? ''`,
  search: (q) => `(() => { const i = document.getElementById('q'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); return true; })()`,
};
let ctx;
const w = (expr) => vs.eval(expr, ctx);
const until = (expr, what, timeout) => waitFor(() => w(expr), { what, timeout });

async function focusWorkbench() {
  await vs.clickElement(`document.querySelector('.part.sidebar .composite.title') || document.querySelector('.part.statusbar')`);
}
async function openFile(rel) {
  if (await vs.quickInputVisible()) await vs.key('Escape');
  await focusWorkbench();
  await vs.key('p', { ctrl: true });
  await waitFor(() => vs.quickInputVisible(), { what: 'quick open' });
  await vs.type(rel);
  await sleep(800);
  await vs.key('Enter');
  const name = path.basename(rel);
  await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith(name)), { what: `${name} to open` });
  await sleep(400);
}
async function shotOfEditor(file) {
  const r = await vs.eval(`(() => { const b = document.querySelector('.part.editor').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  const { data } = await vs.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  writeFileSync(file, Buffer.from(data, 'base64'));
}
async function closeAll() {
  await vs.command('View: Close All Editors');
  await waitFor(async () => (await vs.editorTabs()).length === 0, { what: 'editors to close' });
}
const titleButton = (label) => `document.querySelector('.editor-group-container.active .editor-actions [aria-label^="${label}"]')`;
async function editorText() {
  return vs.eval(`[...document.querySelectorAll('.editor-instance .view-lines .view-line')].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)).map((l) => l.textContent).join('\\n').replace(/\\u00a0/g, ' ')`);
}
async function statusBarSelection() {
  return vs.eval(`document.querySelector('[id="status.editor.selection"]')?.textContent ?? ''`);
}
/** Picks the quick pick item whose label (without its icon) is exactly `label`. */
async function pickExact(label) {
  await waitFor(
    () =>
      vs.eval(`(() => { const row = [...document.querySelectorAll('.quick-input-widget .monaco-list-row')].find((r) => r.querySelector('.label-name')?.textContent.trim() === ${JSON.stringify(label)}); if (!row) return false; row.click(); return true; })()`),
    { what: `quick pick item ${label}` },
  );
  await sleep(300);
}

/** Runs a command whose first act is to open a quick pick of its own. */
async function commandWithPicker(title) {
  if (await vs.quickInputVisible()) await vs.key('Escape');
  await vs.key('F1');
  await waitFor(async () => (await vs.quickInputVisible()) && (await vs.quickInputValue()).startsWith('>'), { what: 'command palette' });
  await vs.type(title);
  await sleep(500);
  await vs.key('Enter');
  await waitFor(async () => (await vs.quickInputVisible()) && !(await vs.quickInputValue()).startsWith('>'), { what: `the picker of ${title}` });
  await sleep(500);
}
/** Opens a diff of two files through Compare Active File With…, then Show Dependency Changes. */
async function compareFiles(a, b) {
  await openFile(a);
  await commandWithPicker('File: Compare Active File With...');
  await vs.type(b);
  await sleep(800);
  await vs.key('Enter');
  await waitFor(async () => vs.eval(`!!document.querySelector('.editor-instance .monaco-diff-editor')`), { what: 'diff editor' });
  await sleep(600);
  await vs.clickElement(titleButton('Show Dependency Changes'));
}
/** Runs the command whose title is exactly `title` (the palette lists recent commands first). */
async function commandExact(title) {
  if (await vs.quickInputVisible()) await vs.key('Escape');
  await vs.key('F1');
  await waitFor(async () => (await vs.quickInputVisible()) && (await vs.quickInputValue()).startsWith('>'), { what: 'command palette' });
  await vs.type(title);
  await sleep(600);
  await waitFor(
    () => vs.eval(`(() => { const row = [...document.querySelectorAll('.quick-input-widget .monaco-list-row')].find((r) => (r.getAttribute('aria-label') || '').split(',')[0].trim() === ${JSON.stringify(title)}); if (!row) return false; row.click(); return true; })()`),
    { what: `command ${title}` },
  );
  await waitFor(async () => !(await vs.quickInputVisible()), { what: 'command palette to close' });
  await sleep(400);
}
async function openScm() {
  await vs.command('Git: Refresh');
  await vs.command('View: Show Source Control');
  await waitFor(() => vs.eval(`!!document.querySelector('.scm-view .monaco-list-row')`), { timeout: 20000, what: 'Source Control view' });
  await sleep(500);
}

try {
  console.log(`VS Code profile: ${root}`);
  await vs.launch(ws);
  await sleep(2000);

  await step('the title button on a lockfile shows HEAD ↔ Working Tree', async () => {
    await openFile('web/package-lock.json');
    await vs.clickElement(titleButton('Show Dependency Changes'));
    ctx = await vs.webview('package-lock.json');
    eq(await w(W.summary), '3 added, 1 removed, 6 upgraded (4 major), 1 changed', 'summary');
    eq(await w(W.range), ['HEAD', 'Working Tree'], 'range');
    eq(await w(W.groups), ['Upgraded 6', 'Added 3', 'Removed 1', 'Changed without a version bump 1'], 'groups');
    eq((await w(W.names)).slice(0, 6), ['@types/node', 'react', 'send', 'typescript', 'lodash', 'ms'], 'upgrades, majors first');
    ok((await w(W.status)).includes('8 unchanged'), 'status line');
    ok((await vs.editorTabs()).some((t) => t.startsWith('package-lock.json (HEAD ↔ Working Tree)')), 'tab title');
    ok(await w(`!!document.querySelector('#rows .row.change .badge.b-major')`), 'major badge');
    ok(await w(`[...document.querySelectorAll('#rows .row.change')].find((r) => r.querySelector('.name').textContent === 'react').querySelector('.tag.direct') !== null`), 'react is direct');
    // 0.x: send 0.18 → 0.19 is breaking under npm's caret ranges, and says why.
    eq(await w(W.rowText('send', '.badge')), 'breaking', 'send badge');
    ok((await w(W.rowAttr('send', '.badge', 'title'))).includes("^0.18 doesn't accept 0.19.0"), 'breaking explained');
    // The range package.json declares, next to the resolved change.
    eq(await w(W.rowText('react', '.range-change')), '^17.0.2 → ^18.2.0', 'declared range');
  });

  if (shotsFor) {
    mkdirSync(shotsFor, { recursive: true });
    await sleep(400);
    await shotOfEditor(path.join(shotsFor, 'overview-dark.png'));
  }

  await step('filters: major, added, direct only and search', async () => {
    await w(W.filter('major'));
    eq(await w(W.names), ['@types/node', 'react', 'send', 'typescript'], 'major');
    eq(await w(W.filterCount('major')), '4', 'major count');
    await w(W.filter('added'));
    eq(await w(W.names), ['scheduler', 'undici-types', 'zod'], 'added');
    await w(W.click('#direct'));
    eq(await w(W.names), ['zod'], 'added and direct');
    eq(await w(W.filterCount('all')), '7', 'direct count');
    await w(W.filter('all'));
    await w(W.search('ty'));
    await until(`${W.names}.length === 2`, 'search to apply');
    eq(await w(W.names), ['@types/node', 'typescript'], 'search');
    await w(W.search(''));
    await w(W.click('#direct'));
    await until(`${W.names}.length === 11`, 'everything back');
  });

  await step('keyboard: arrows move, Enter folds a group', async () => {
    await w(`document.getElementById('list').focus()`);
    await w(`document.getElementById('list').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))`);
    await w(`document.getElementById('list').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    eq((await w(W.groups))[0], 'Upgraded 6', 'header stays');
    eq((await w(W.names))[0], 'scheduler', 'upgrades folded away');
    await w(`document.getElementById('list').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
    eq((await w(W.names))[0], '@types/node', 'unfolded with ArrowRight');
    await w(`document.getElementById('list').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
    ok(await w(`document.querySelector('#rows .row.sel .name')?.textContent === '@types/node'`), 'ArrowDown selects the first change');
  });

  await step('Copy as Markdown puts a table on the clipboard', async () => {
    await w(W.filter('major'));
    await w(W.click('#copy'));
    await sleep(300);
    await w(W.filter('all'));
    await focusWorkbench();
    await vs.key('n', { ctrl: true });
    await waitFor(async () => (await vs.editorTabs()).some((t) => /^Untitled-\d+$/.test(t)), { what: 'untitled editor' });
    await sleep(300);
    await vs.key('v', { ctrl: true });
    await sleep(500);
    const text = await editorText();
    ok(text.startsWith('### Dependency changes'), `heading, got: ${text.slice(0, 80)}`);
    ok(text.includes('4 upgraded (4 major) (HEAD → Working Tree).'), 'summary of what was shown');
    ok(text.includes('| [react](https://www.npmjs.com/package/react/v/18.2.0) (direct) | major upgrade | `17.0.2` | `18.2.0` | `^17.0.2 → ^18.2.0` |'), `react row: ${text}`);
    ok(text.includes('| breaking upgrade \\(0.x\\) | `0.18.0` | `0.19.0` |'), 'send row');
    ok(!text.includes('lodash'), 'only the filtered rows');
    await vs.command('View: Revert and Close Editor');
  });

  await step('go to entry opens the lockfile at the package', async () => {
    await vs.showTab('package-lock.json (HEAD');
    ctx = await vs.webview('package-lock.json');
    await w(W.rowAct('zod', 'reveal'));
    await waitFor(async () => (await vs.editorTabs()).filter((t) => t === 'package-lock.json').length >= 1, { what: 'lockfile editor' });
    await waitFor(async () => /Ln \d+/.test(await statusBarSelection()), { what: 'cursor position' });
    const ln = Number(/Ln (\d+)/.exec(await statusBarSelection())[1]);
    const lines = readFileSync(path.join(ws, 'web/package-lock.json'), 'utf8').split('\n');
    eq(lines[ln - 1].trim(), '"node_modules/zod": {', 'the line the cursor is on');
  });

  await step('the view follows edits to the working tree', async () => {
    await closeAll();
    await openFile('web/package-lock.json');
    await vs.clickElement(titleButton('Show Dependency Changes'));
    ctx = await vs.webview('package-lock.json');
    // Back to what HEAD has: nothing left to show.
    try {
      copyFileSync(fx('npm/v3/old.json'), path.join(ws, 'web/package-lock.json'));
      await until(`${W.summary} === 'No dependency changes'`, 'refresh after the file changed', 15000);
      await sleep(1500); // and it stays that way: no later refresh reads a stale copy
      const notes = await w(W.notes);
      ok(notes.some((n) => n.startsWith("The lockfile itself didn't change (16 packages)")), `empty state: ${JSON.stringify(notes)}`);
      // package.json still asks for the new versions: the lockfile is behind it.
      ok(notes.some((n) => n.includes("package.json changes 6 dependencies, but package-lock.json didn't change")), `warning: ${JSON.stringify(notes)}`);
      ok(notes.some((n) => n.includes('react (^18.2.0; locked 17.0.2)')), 'range check');
    } finally {
      copyFileSync(fx('npm/v3/new.json'), path.join(ws, 'web/package-lock.json'));
    }
    await until(`${W.summary}.startsWith('3 added')`, 'refresh back', 15000);
  });

  await step('a staged lockfile: Source Control diff → HEAD ↔ Index', async () => {
    await closeAll();
    await openScm();
    await vs.clickElement(`[...document.querySelectorAll('.scm-view .monaco-list-row')].find((r) => (r.getAttribute('aria-label') || '').includes('pubspec.lock'))`);
    await waitFor(async () => vs.eval(`!!document.querySelector('.editor-instance .monaco-diff-editor')`), { what: 'diff editor' });
    await sleep(800);
    await vs.clickElement(titleButton('Show Dependency Changes'));
    ctx = await vs.webview('pubspec.lock');
    eq(await w(W.range), ['HEAD', 'Index'], 'range');
    eq(await w(W.summary), '1 added, 1 removed, 6 upgraded (3 major)', 'summary');
  });

  await step('Source Control context menu on a changed lockfile', async () => {
    await closeAll();
    await openScm();
    await vs.clickElement(`[...document.querySelectorAll('.scm-view .monaco-list-row')].find((r) => (r.getAttribute('aria-label') || '').includes('package-lock.json'))`, 'right');
    await waitFor(() => vs.eval(`!!document.querySelector('.monaco-menu .action-label[aria-label="Show Dependency Changes"]')`), { what: 'context menu item' });
    await vs.clickElement(`document.querySelector('.monaco-menu .action-label[aria-label="Show Dependency Changes"]')`);
    ctx = await vs.webview('package-lock.json');
    // In the Changes group: the unstaged change, Index → Working Tree.
    eq(await w(W.range), ['Index', 'Working Tree'], 'range');
    eq(await w(W.summary), '3 added, 1 removed, 6 upgraded (4 major), 1 changed', 'summary');
  });

  await step('Show All Dependency Changes from the Source Control title bar', async () => {
    await closeAll();
    await openScm();
    await vs.clickElement(`document.querySelector('.part.sidebar [aria-label="Show All Dependency Changes"]')`);
    ctx = await vs.webview('2 lockfiles');
    eq(await w(W.files), ['web/package-lock.json', 'app/pubspec.lock'], 'files, npm first');
    eq(await w(W.summary), '4 added, 2 removed, 12 upgraded (7 major), 1 changed', 'summary');
    ok(await w(`[...document.querySelectorAll('#rows .row.file .eco')].map((e) => e.textContent).join() === 'npm,pub.dev'`), 'ecosystem badges');
  });

  if (shotsFor) {
    // The whole window: where the buttons are, next to the result.
    await vs.eval(`document.querySelector('.part.sidebar [aria-label="Show All Dependency Changes"]')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
    await sleep(400);
    await vs.screenshot(path.join(shotsFor, 'source-control-dark.png'));
  }

  await step('a lockfile collapses, and its text diff opens', async () => {
    await w(W.click('#rows .row.file'));
    eq(await w(W.files), ['web/package-lock.json', 'app/pubspec.lock'], 'both headers stay');
    eq((await w(W.names))[0], 'flutter_lints', 'npm rows folded away');
    await w(W.click('#rows .row.file'));
    await w(`document.querySelector('#rows .row.file [data-act="textDiff"]').click()`);
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith('package-lock.json (HEAD ↔ Working Tree)') && t !== 'package-lock.json (HEAD ↔ Working Tree)') || vs.eval(`!!document.querySelector('.editor-instance .monaco-diff-editor')`), { what: 'text diff' });
  });

  if (shotsFor) {
    await closeAll();
    const userSettings = path.join(root, 'user-data', 'User', 'settings.json');
    writeFileSync(userSettings, JSON.stringify({ ...settings, 'workbench.colorTheme': 'Default Light Modern' }, null, 2));
    await sleep(1500);
    await vs.command('Lockfile Diff: Show All Dependency Changes');
    ctx = await vs.webview('2 lockfiles');
    await w(W.filter('major'));
    await sleep(500);
    await shotOfEditor(path.join(shotsFor, 'all-lockfiles-light.png'));
    await w(W.filter('all'));
    writeFileSync(userSettings, JSON.stringify(settings, null, 2));
    await sleep(1500);
  }

  await step('compare every lockfile with a tag', async () => {
    await closeAll();
    await commandWithPicker('Lockfile Diff: Compare with Branch, Tag or Commit');
    await vs.pickQuickItem('v1.0.0');
    ctx = await vs.webview('3 lockfiles');
    eq(await w(W.range), ['v1.0.0', 'Working Tree'], 'range');
    eq(await w(W.files), ['Cargo.lock', 'web/package-lock.json', 'app/pubspec.lock'], 'files by ecosystem');
  });

  await step('compare one lockfile between two refs', async () => {
    await closeAll();
    await openFile('Cargo.lock');
    await commandWithPicker('Lockfile Diff: Compare Two Branches, Tags or Commits');
    await vs.pickQuickItem('release-1.0');
    await waitFor(async () => (await vs.eval(`document.querySelector('.quick-input-widget .quick-input-title')?.textContent ?? ''`)).includes('in release-1.0 with'), { what: 'second picker' });
    await pickExact('main');
    ctx = await vs.webview('Cargo.lock');
    eq(await w(W.range), ['release-1.0', 'main'], 'range');
    eq(await w(W.summary), '1 added, 3 upgraded, 1 changed', 'summary');
    ok((await w(W.notes)).includes('Format changed: Cargo.lock v3 → Cargo.lock v4.'), 'format note');
  });

  await step('a branch compares from its merge base, and tip to tip on request', async () => {
    await closeAll();
    await commandWithPicker('Lockfile Diff: Compare Two Branches, Tags or Commits');
    await pickExact('main');
    await waitFor(async () => (await vs.eval(`document.querySelector('.quick-input-widget .quick-input-title')?.textContent ?? ''`)).includes('in main with'), { what: 'second picker' });
    await pickExact('deps/web');
    ctx = await vs.webview('package-lock.json');
    // Only what deps/web changes: main's crate bump since the branch point is not undone.
    eq(await w(W.range), ['main', 'deps/web'], 'range');
    eq(await w(`document.querySelector('#range .conn')?.textContent`), '...', 'three dots');
    eq(await w(W.summary), '3 added, 1 removed, 6 upgraded (4 major), 1 changed', 'summary');
    ok((await w(`document.getElementById('base').textContent`)).startsWith('What deps/web changes since it branched from main (merge base '), 'merge base explained');
    ok((await vs.editorTabs()).some((t) => t === 'Dependencies (main...deps/web)'), `tab title: ${JSON.stringify(await vs.editorTabs())}`);
    await w(W.click('#baseToggle'));
    ctx = await vs.webview('2 lockfiles');
    eq(await w(W.files), ['Cargo.lock', 'web/package-lock.json'], 'tip to tip also has Cargo.lock');
    ok((await w(`document.getElementById('base').textContent`)).startsWith('Tip to tip'), 'tip to tip explained');
    ok((await w(W.notes)).length >= 0 && (await w(`[...document.querySelectorAll('#rows .row.group .glabel')].map((e) => e.textContent)`)).includes('Downgraded'), 'main\'s bump reads as a downgrade');
    await w(W.click('#baseToggle'));
    ctx = await vs.webview('package-lock.json');
  });

  if (shotsFor) {
    await sleep(400);
    await shotOfEditor(path.join(shotsFor, 'merge-base-dark.png'));
  }

  await step('Show Dependency Changes on This Branch starts at the default branch', async () => {
    await closeAll();
    await vs.command('Lockfile Diff: Show Dependency Changes on This Branch');
    ctx = await vs.webview('lockfiles');
    eq(await w(W.range), ['main', 'Working Tree'], 'range');
    eq(await w(W.files), ['web/package-lock.json', 'app/pubspec.lock'], 'files');
  });

  await step('a manifest change the lockfile does not reflect is flagged', async () => {
    await closeAll();
    write('Cargo.toml', cargoToml('5'));
    try {
      // From the palette with no lockfile open: every changed lockfile of the repository.
      await commandExact('Lockfile Diff: Show Dependency Changes');
      ctx = await vs.webview('3 lockfiles');
      eq(await w(W.range), ['HEAD', 'Working Tree'], 'range');
      eq(await w(W.files), ['Cargo.lock', 'web/package-lock.json', 'app/pubspec.lock'], 'Cargo.lock comes in through Cargo.toml');
      const notes = await w(W.notes);
      // Cargo.lock doesn't record declared ranges: an unchanged one is flagged by the range check alone.
      ok(!notes.some((n) => n.includes("the lockfile wasn't updated")), `no stale-lockfile warning for Cargo: ${JSON.stringify(notes)}`);
      ok(notes.some((n) => n.includes('clap (5; locked 4.5.20)')), 'range check');
      ok((await w(`document.getElementById('summary').textContent`)).includes('1 warning'), 'warning chip');
      if (shotsFor) await shotOfEditor(path.join(shotsFor, 'manifest-warning-dark.png'));
    } finally {
      write('Cargo.toml', cargoToml('4'));
    }
  });

  await step('Lockfile History lists the commits with what each did', async () => {
    await closeAll();
    await openFile('Cargo.lock');
    await vs.command('Lockfile Diff: Show Lockfile History');
    const rows = `[...document.querySelectorAll('.pane')].find((p) => p.querySelector('.pane-header')?.textContent.includes('Lockfile History'))?.querySelectorAll('.monaco-list-row') ?? []`;
    const read = `[...${rows}].map((r) => r.querySelector('.label-name')?.textContent + ' | ' + r.querySelector('.label-description')?.textContent)`;
    await waitFor(async () => (await vs.eval(read)).length === 2 && !(await vs.eval(read)).some((t) => t.includes('reading')), { what: 'history with summaries', timeout: 15000 });
    const items = await vs.eval(read);
    ok(items[0].startsWith('Bump crates | +1 ↑3 ~1 · '), `newest first: ${items[0]}`);
    ok(items[1].startsWith('Initial lockfiles | created · +6 · '), `the first commit: ${items[1]}`);
    await vs.clickElement(`[...${rows}][0]`);
    ctx = await vs.webview('Cargo.lock');
    eq(await w(W.summary), '1 added, 3 upgraded, 1 changed', 'that commit\'s changes');
    ok((await w(W.range))[0].endsWith('^'), 'parent on the left');
    if (shotsFor) {
      await sleep(400);
      await vs.screenshot(path.join(shotsFor, 'history-dark.png'));
    }
    // The next commit reuses the same tab instead of opening another.
    await vs.clickElement(`[...${rows}][1]`);
    await waitFor(async () => (await vs.eval(`[...document.querySelectorAll('.tabs-container .tab')].map((t) => t.getAttribute('aria-label') ?? '').filter((l) => l.startsWith('Cargo.lock (')).join('|')`)).includes('empty'), { what: 'the history tab showing the first commit' });
    eq(await vs.eval(`[...document.querySelectorAll('.tabs-container .tab')].filter((t) => (t.getAttribute('aria-label') ?? '').startsWith('Cargo.lock (')).length`), 1, 'one history tab');
    await vs.command('Lockfile Diff: Close Lockfile History');
  });

  await step('Go pseudo-versions read as commits with dates', async () => {
    await closeAll();
    await compareFiles('compare/go-old/go.mod', 'compare/go-new/go.mod');
    ctx = await vs.webview('go.mod');
    eq(await w(W.rowText('github.com/jackc/pgservicefile', '.ver')), '091c0ba (2022-12-27)5a60cdf (2024-06-06)', 'commit and date');
    eq(await w(W.rowText('github.com/jackc/pgservicefile', '.badge')), 'commit', 'commit badge');
    eq(await w(W.rowText('golang.org/x/crypto', '.badge')), 'v0 minor', 'v0 marked');
  });

  await step('an npm alias shows the real package and its alias', async () => {
    await closeAll();
    await compareFiles('compare/alias-old/package-lock.json', 'compare/alias-new/package-lock.json');
    ctx = await vs.webview('package-lock.json');
    eq(await w(`[...document.querySelectorAll('#rows .row.change .name')].map((e) => e.textContent)`), ['string-width as string-width-cjs'], 'name and alias');
  });

  await step('an unknown ref is refused in the picker', async () => {
    await commandWithPicker('Lockfile Diff: Compare with Branch, Tag or Commit');
    await vs.type('no-such-branch');
    await sleep(300);
    await vs.key('Enter');
    await waitFor(() => vs.eval(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].some((r) => r.textContent.includes('is not a branch, tag or commit'))`), { what: 'error row' });
    await vs.key('Escape');
  });

  await step('two different lockfiles through Compare Active File With…', async () => {
    await closeAll();
    await openFile('compare/old/yarn.lock');
    await commandWithPicker('File: Compare Active File With...');
    await vs.type('compare/new/yarn.lock');
    await sleep(800);
    await vs.key('Enter');
    await waitFor(async () => vs.eval(`!!document.querySelector('.editor-instance .monaco-diff-editor')`), { what: 'diff editor' });
    await sleep(600);
    await vs.clickElement(titleButton('Show Dependency Changes'));
    ctx = await vs.webview('yarn.lock');
    eq(await w(W.summary), '1 added, 6 upgraded (1 major)', 'summary');
    ok((await w(W.notes)).some((n) => n.includes('Direct dependencies come from package.json')) === false, 'no package.json next to these');
  });

  await step('a malformed lockfile is reported, not a crash', async () => {
    await closeAll();
    write('Cargo.lock', '[[package]\nname = "broken"\n');
    await openFile('Cargo.lock');
    await vs.clickElement(titleButton('Show Dependency Changes'));
    ctx = await vs.webview('Cargo.lock');
    await until(`${W.notes}.some((n) => n.includes('not valid TOML'))`, 'error row');
    ok((await w(W.notes))[0].startsWith('Cargo.lock in Working Tree: Cargo.lock is not valid TOML'), 'names the side');
    put('Cargo.lock', fx('cargo/new.lock'));
  });

  await step('the comparison comes back after Reload Window', async () => {
    await closeAll();
    await openFile('web/package-lock.json');
    await vs.clickElement(titleButton('Show Dependency Changes'));
    ctx = await vs.webview('package-lock.json');
    await w(W.filter('major'));
    await sleep(500);
    await focusWorkbench();
    vs.contexts.clear();
    await vs.command('Developer: Reload Window');
    await sleep(3000);
    await waitFor(() => vs.eval('!!document.querySelector(".monaco-workbench .part.statusbar")').catch(() => false), { timeout: 30000, what: 'workbench after reload' });
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith('package-lock.json (HEAD ↔ Working Tree)')), { timeout: 20000, what: 'restored tab' });
    await vs.showTab('package-lock.json (HEAD');
    ctx = await vs.webview('package-lock.json', 20000);
    await until(`${W.summary}.startsWith('3 added')`, 'restored comparison', 20000);
    eq(await w(W.names), ['@types/node', 'react', 'send', 'typescript'], 'filter kept');
  });

  await step('no errors in the webviews', async () => {
    eq(vs.pageErrors, [], 'page errors');
  });
} finally {
  await vs.close();
}

// Restricted Mode: a second window that doesn't trust the folder.
const root2 = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'lockfile-diff-e2e-restricted-')));
const vs2 = new VSCode(root2);
try {
  vs2.install(vsix, { ...settings, 'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never', 'security.workspace.trust.banner': 'never' });
  await vs2.launch(ws);
  await sleep(2000);
  vs = vs2;

  await step('Restricted Mode: no title button where Git would be needed, and the command explains itself', async () => {
    await openFile('web/package-lock.json');
    await sleep(500);
    ok(!(await vs.eval(`!!${titleButton('Show Dependency Changes')}`)), 'no title button on a plain lockfile');
    await vs.command('Lockfile Diff: Show Dependency Changes');
    await waitFor(async () => (await vs.notifications()).some((n) => n.includes('needs a trusted workspace')), { what: 'trust message' });
  });

  await step('Restricted Mode: comparing two files still works', async () => {
    await vs.clearNotifications();
    await closeAll();
    await openFile('compare/old/yarn.lock');
    await commandWithPicker('File: Compare Active File With...');
    await vs.type('compare/new/yarn.lock');
    await sleep(800);
    await vs.key('Enter');
    await waitFor(async () => vs.eval(`!!document.querySelector('.editor-instance .monaco-diff-editor')`), { what: 'diff editor' });
    await sleep(600);
    await vs.clickElement(titleButton('Show Dependency Changes'));
    ctx = await vs.webview('yarn.lock');
    eq(await w(W.summary), '1 added, 6 upgraded (1 major)', 'summary');
  });
} finally {
  await vs2.close();
  console.log(`\n${passed} passed, ${failed.length} failed${failed.length ? `: ${failed.join('; ')}` : ''}`);
  console.log(`Profile and screenshots: ${root}`);
  process.exitCode = failed.length ? 1 : 0;
}
