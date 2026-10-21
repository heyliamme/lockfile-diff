import { toMarkdown } from '../src/core/markdown';
import { REGISTRY_NAMES } from '../src/core/registry';
import type { Change, FileDiff } from '../src/core/types';
import { rangeText } from '../src/core/markdown';
import { displayVersion, isPrerelease } from '../src/core/version';
import type { FileRef, Filter, FromWebview, ToWebview, ViewData, ViewOptions } from '../src/protocol';
import { buildRows, FILTER_LABEL, FILTERS, filterCounts, GROUP_LABEL, overall, treeInfo, visibleChanges, type Row, type ViewState } from './model';

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const send = (m: FromWebview) => vscode.postMessage(m);

const ROW_H = 26;
const OVERSCAN = 12;

const app = document.getElementById('app')!;
const initial = JSON.parse(decodeURIComponent(app.dataset.state ?? '%7B%7D')) as { request?: unknown };
const saved = (vscode.getState() ?? {}) as { request?: unknown; options?: ViewOptions; query?: string };
let request = saved.request ?? initial.request;

let data: ViewData | undefined;
const state: ViewState = { filter: saved.options?.filter ?? 'all', directOnly: saved.options?.directOnly ?? false, query: saved.query ?? '', collapsed: new Set() };
let optionsFromHost = !!saved.options;
let rows: Row[] = [];
let tree: { level: number; pos: number; size: number }[] = [];
let sel = -1;

// --- elements ---------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const icon = (name: string, cls = '') => el('i', `codicon codicon-${name} ${cls}`.trim());
function button(cls: string, label: string, iconName?: string, title?: string) {
  const b = el('button', cls);
  b.type = 'button';
  if (iconName) b.append(icon(iconName));
  if (label) b.append(el('span', undefined, label));
  if (title) b.title = title;
  if (!label && title) b.setAttribute('aria-label', title);
  return b;
}

const top = el('header', 'top');
const titles = el('div', 'titles');
const title = el('h1', 'title');
title.id = 'title';
const range = el('div', 'range');
range.id = 'range';
// For a comparison from a branch: which starting point, and a switch to the other.
const baseBar = el('div', 'basebar');
baseBar.id = 'base';
baseBar.hidden = true;
titles.append(title, range, baseBar);
const actions = el('div', 'actions');
const diffBtn = button('icon', '', 'diff', 'Open the text diff of the lockfile');
diffBtn.id = 'textDiff';
diffBtn.hidden = true;
const copyBtn = button('', 'Copy as Markdown', 'copy', 'Copy the changes shown below as a Markdown table, for a pull request or a review');
copyBtn.id = 'copy';
const refreshBtn = button('icon', '', 'refresh', 'Refresh');
refreshBtn.id = 'refresh';
actions.append(diffBtn, copyBtn, refreshBtn);
top.append(titles, actions);

const summary = el('div', 'summary');
summary.id = 'summary';

const bar = el('div', 'bar');
const filters = el('div', 'segmented');
filters.id = 'filters';
filters.setAttribute('role', 'radiogroup');
filters.setAttribute('aria-label', 'Show');
const directLabel = el('label', 'toggle');
const direct = el('input');
direct.type = 'checkbox';
direct.id = 'direct';
directLabel.append(direct, el('span', undefined, 'Direct only'));
const search = el('div', 'search');
const query = el('input');
query.id = 'q';
query.type = 'search';
query.placeholder = 'Filter packages';
query.setAttribute('aria-label', 'Filter packages by name');
query.value = state.query;
search.append(icon('search'), query);
bar.append(filters, directLabel, search);

const list = el('div', 'list');
list.id = 'list';
list.tabIndex = 0;
// A tree: files hold groups, groups hold changes. Selection is aria-activedescendant.
list.setAttribute('role', 'tree');
list.setAttribute('aria-label', 'Dependency changes');
const spacer = el('div', 'spacer');
const rowsEl = el('div', 'rows');
rowsEl.id = 'rows';
spacer.append(rowsEl);
list.append(spacer);

// What filters and search leave shown, and slow reads: announced politely.
const status = el('div', 'status');
status.id = 'status';
status.setAttribute('role', 'status');
status.setAttribute('aria-live', 'polite');

app.append(top, summary, bar, list, status);

// --- rendering --------------------------------------------------------------------

function saveState() {
  const options: ViewOptions = { filter: state.filter, directOnly: state.directOnly };
  vscode.setState({ request, options, query: state.query });
  return options;
}

function persist() {
  send({ type: 'state', options: saveState() });
}

const KIND_ICON = { upgraded: 'arrow-up', downgraded: 'arrow-down', added: 'add', removed: 'remove', changed: 'sync' } as const;

function chip(cls: string, text: string) {
  return el('span', `chip ${cls}`, text);
}

function renderSummary() {
  if (!data) return summary.replaceChildren();
  const all = data.files.flatMap((f) => f.changes);
  const n = (k: string) => all.filter((c) => c.kind === k).length;
  const majors = all.filter((c) => c.kind === 'upgraded' && c.bump === 'major').length;
  const line = el('span', 'line', overall(data.files));
  line.id = 'summaryText';
  const chips = el('span', 'chips');
  if (n('added')) chips.append(chip('k-added', `+${n('added')}`));
  if (n('removed')) chips.append(chip('k-removed', `−${n('removed')}`));
  if (n('upgraded')) chips.append(chip('k-upgraded', `↑${n('upgraded')}`));
  if (majors) chips.append(chip('b-major', `${majors} major`));
  if (n('downgraded')) chips.append(chip('k-downgraded', `↓${n('downgraded')}`));
  if (n('changed')) chips.append(chip('k-changed', `~${n('changed')}`));
  const warnings = data.files.reduce((k, f) => k + (f.warnings?.length ?? 0), 0);
  if (warnings) chips.append(chip('warn', `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`));
  // Rebuilt only when it says something new (live refreshes repeat the same numbers).
  const fresh = el('div');
  fresh.append(line, chips);
  if (fresh.innerHTML !== summary.innerHTML) summary.replaceChildren(...fresh.childNodes);
}

function renderFilters() {
  if (!data) return;
  // Nothing to filter when no lockfile changed: only the message and the status remain.
  bar.hidden = !data.files.length;
  const counts = filterCounts(data.files, state);
  // Downgraded and Changed only when there are some; the rest always, so the bar doesn't jump.
  const shown = FILTERS.filter((f) => !((f === 'downgraded' || f === 'changed') && !counts[f] && state.filter !== f));
  let btns = [...filters.querySelectorAll<HTMLButtonElement>('[data-filter]')];
  // The buttons stay as long as the same filters are offered, so keyboard focus stays on them.
  if (btns.map((b) => b.dataset.filter).join() !== shown.join()) {
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.filter;
    btns = shown.map((f) => {
      const b = button('seg', '');
      b.dataset.filter = f;
      b.setAttribute('role', 'radio');
      b.append(el('span', undefined, FILTER_LABEL[f]), el('span', 'count'));
      return b;
    });
    filters.replaceChildren(...btns);
    if (focused) (btns.find((b) => b.dataset.filter === focused) ?? btns.find((b) => b.dataset.filter === state.filter))?.focus();
  }
  for (const b of btns) {
    const f = b.dataset.filter as Filter;
    const on = state.filter === f;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
    // One Tab stop for the group, on the checked radio; arrows move between them.
    b.tabIndex = on ? 0 : -1;
    b.querySelector('.count')!.textContent = String(counts[f]);
  }
  const known = data.files.some((f) => f.directKnown);
  direct.disabled = !known;
  direct.checked = state.directOnly && known;
  directLabel.title = known ? 'Only packages your project depends on itself' : "These lockfiles don't record which dependencies are direct.";
  directLabel.classList.toggle('disabled', !known);
}

function setStatus(text: string) {
  // Only on a change, so a screen reader hears a new count and not every live refresh.
  if (status.textContent !== text) status.replaceChildren(el('span', undefined, text));
}

function renderStatus() {
  if (!data) return setStatus('');
  if (!data.files.length) return setStatus(data.message ?? 'No lockfiles changed.');
  const unchanged = data.files.reduce((n, f) => n + f.unchanged, 0);
  const shown = rows.filter((r) => r.t === 'change').length;
  const total = data.files.reduce((n, f) => n + f.changes.length, 0);
  const parts = [shown === total ? `${total} ${total === 1 ? 'change' : 'changes'}` : `${shown} of ${total} changes shown`, `${unchanged.toLocaleString('en-US')} unchanged`];
  if (data.files.length === 1 && !data.files[0].error) parts.push(data.files[0].format);
  if (data.live) parts.push('follows your edits');
  setStatus(parts.join(' · '));
}

/** The bump badge: plain semver, or what an ecosystem's 0.x and commit conventions make of it. */
function bumpBadge(c: Change): HTMLElement | undefined {
  let b: HTMLElement | undefined;
  if (c.flag === 'breaking') b = el('span', 'badge b-major', 'breaking');
  else if (c.flag === 'commit' && (!c.bump || c.bump === 'other')) b = el('span', 'badge b-commit', 'commit');
  else if (c.bump && c.bump !== 'other') b = el('span', `badge b-${c.bump}`, c.flag === 'v0' ? `v0 ${c.bump}` : c.bump);
  else if (c.to && c.kind !== 'removed' && isPrerelease(c.to) && !c.flag) b = el('span', 'badge b-prerelease', 'pre');
  if (b && c.why) {
    b.title = c.why;
    b.classList.add('why');
  }
  return b;
}

function changeRow(r: Extract<Row, { t: 'change' }>, file: FileDiff) {
  const c = r.change;
  const row = el('div', `row change k-${c.kind}`);
  row.append(icon(KIND_ICON[c.kind], 'kind'));
  const name = el('span', 'name', c.name);
  name.title = c.alias ? `${c.name}, installed as ${c.alias}` : c.name;
  if (c.alias) name.append(el('span', 'alias', ` as ${c.alias}`));
  row.append(name);
  const ver = el('span', 'ver');
  const shown = (v?: string) => displayVersion(file.ecosystem, v);
  if (c.kind === 'added') ver.append(el('span', 'to', shown(c.to)));
  else if (c.kind === 'removed') ver.append(el('span', 'from gone', shown(c.from)));
  else ver.append(el('span', 'from', shown(c.from)), icon('arrow-right', 'arrow'), el('span', 'to', shown(c.to)));
  ver.title = [c.from, c.to].filter(Boolean).join(' → ');
  row.append(ver);
  const badges = el('span', 'badges');
  const bb = bumpBadge(c);
  if (bb) badges.append(bb);
  if (c.direct === true) badges.append(el('span', 'tag direct', 'direct'));
  else if (c.direct === false) badges.append(el('span', 'tag', 'transitive'));
  if (c.dev) badges.append(el('span', 'tag', 'dev'));
  row.append(badges);
  const note = el('span', 'note');
  const declaredIn = file.manifest?.file ?? 'the manifest';
  if (c.range) {
    const rg = el('span', 'range-change', rangeText(c.range));
    rg.title = `Declared in ${declaredIn}: ${rangeText(c.range)}`;
    note.append(rg);
  }
  if (c.note) note.append(el('span', undefined, c.note));
  note.title = [c.range ? `declared ${rangeText(c.range)}` : '', c.note ?? ''].filter(Boolean).join('; ');
  row.append(note);
  // A narrow view has no room for the note column: a marker carries it, and the version's tooltip too.
  if (note.title) {
    const hint = icon('info', 'note-hint');
    hint.title = note.title;
    badges.append(hint);
    ver.title = `${ver.title}\n${note.title}`;
  }
  const acts = el('span', 'acts');
  const reveal = button('icon', '', 'go-to-file', `Go to ${c.name} in the lockfile`);
  reveal.dataset.act = 'reveal';
  reveal.tabIndex = -1;
  acts.append(reveal);
  if (c.url) {
    const open = button('icon', '', 'link-external', `Open ${c.name} on ${REGISTRY_NAMES[file.ecosystem]}`);
    open.dataset.act = 'open';
    open.tabIndex = -1;
    acts.append(open);
  }
  row.append(acts);
  const what = c.kind === 'added' ? `added ${shown(c.to)}` : c.kind === 'removed' ? `removed ${shown(c.from)}` : `${c.kind} from ${shown(c.from)} to ${shown(c.to)}`;
  const bumpText = c.flag === 'breaking' ? ', breaking' : c.bump && c.bump !== 'other' ? `, ${c.flag === 'v0' ? 'v0 ' : ''}${c.bump}` : '';
  const parts = [
    `${c.name}${c.alias ? ` as ${c.alias}` : ''}, ${what}${bumpText}`,
    c.direct === true ? 'direct' : c.direct === false ? 'transitive' : '',
    c.dev ? 'dev' : '',
    c.range ? `declared ${rangeText(c.range)}` : '',
    c.why ?? '',
    c.note ?? '',
  ];
  row.setAttribute('aria-label', parts.filter(Boolean).join(', '));
  return row;
}

function drawRow(r: Row): HTMLElement {
  if (r.t === 'change') return changeRow(r, data!.files[r.fileIdx]);
  if (r.t === 'file') {
    const row = el('div', 'row file');
    row.setAttribute('aria-expanded', String(!r.collapsed));
    row.append(icon(r.collapsed ? 'chevron-right' : 'chevron-down', 'twisty'));
    row.append(el('span', 'fname', r.file.path));
    row.append(el('span', `eco eco-${r.file.ecosystem}`, REGISTRY_NAMES[r.file.ecosystem]));
    const fsum = el('span', 'fsum', r.file.error ? "couldn't be read" : overall([r.file]));
    if (r.file.warnings?.length) fsum.prepend(icon('warning', 'warn'), ' ');
    row.append(fsum);
    const acts = el('span', 'acts');
    const td = button('icon', '', 'diff', `Open the text diff of ${r.file.path} (Shift+Enter)`);
    td.dataset.act = 'textDiff';
    td.tabIndex = -1;
    acts.append(td);
    row.append(acts);
    return row;
  }
  if (r.t === 'group') {
    const row = el('div', `row group k-${r.kind}`);
    row.setAttribute('aria-expanded', String(!r.collapsed));
    row.append(icon(r.collapsed ? 'chevron-right' : 'chevron-down', 'twisty'));
    row.append(el('span', 'glabel', GROUP_LABEL[r.kind]), el('span', 'gcount', String(r.count)));
    if (r.detail) row.append(el('span', 'gdetail', r.detail));
    return row;
  }
  if (r.t === 'note') {
    const row = el('div', `row note ${r.level}`);
    row.append(icon(r.level === 'error' ? 'error' : r.level === 'warn' ? 'warning' : 'info'), el('span', 'text', r.text));
    row.title = r.text;
    return row;
  }
  const row = el('div', 'row empty');
  row.append(el('span', 'text', r.text));
  return row;
}

function paint() {
  const h = list.clientHeight || 600;
  const first = Math.max(0, Math.floor(list.scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((list.scrollTop + h) / ROW_H) + OVERSCAN);
  const frag = document.createDocumentFragment();
  for (let i = first; i < last; i++) {
    const r = rows[i];
    const e = drawRow(r);
    e.dataset.i = String(i);
    e.style.top = `${i * ROW_H}px`;
    e.id = `row-${i}`;
    // Rows are virtualised: each says where it sits, since the others may not be in the DOM.
    e.setAttribute('role', 'treeitem');
    e.setAttribute('aria-level', String(tree[i].level));
    e.setAttribute('aria-posinset', String(tree[i].pos));
    e.setAttribute('aria-setsize', String(tree[i].size));
    e.setAttribute('aria-selected', String(i === sel));
    if (i === sel) e.classList.add('sel');
    frag.append(e);
  }
  rowsEl.replaceChildren(frag);
  list.setAttribute('aria-activedescendant', sel >= first && sel < last ? `row-${sel}` : '');
}

function rebuild(keepKey?: string) {
  if (!data) return;
  const prevKey = keepKey ?? rows[sel]?.key;
  rows = buildRows(data.files, state);
  if (data.message && !data.files.length) rows = [{ t: 'empty', key: 'message', text: data.message }];
  rows = [...(data.notices ?? []).map((text, i): Row => ({ t: 'note', key: `notice:${i}`, fileIdx: -1, text, level: 'info' })), ...rows];
  tree = treeInfo(rows);
  sel = prevKey ? rows.findIndex((r) => r.key === prevKey) : -1;
  spacer.style.height = `${rows.length * ROW_H}px`;
  renderFilters();
  renderStatus();
  // Copy what is shown, so nothing to copy when the filters leave nothing.
  copyBtn.disabled = !visibleChanges(data.files, state).some((f) => f.changes.length);
  paint();
}

function renderBase() {
  const b = data?.base;
  const hadFocus = document.activeElement?.id === 'baseToggle';
  baseBar.replaceChildren();
  baseBar.hidden = !b || (!b.diverged && !b.unrelated);
  if (!data || !b || baseBar.hidden) return;
  const { left, right } = data;
  if (b.unrelated) {
    baseBar.append(icon('info'), el('span', undefined, `${left} and ${right} share no history: compared tip to tip.`));
    return;
  }
  const mb = b.mode === 'mergeBase';
  const text = mb
    ? `What ${right} changes since it branched from ${left} (merge base ${b.mergeBase?.slice(0, 8) ?? '?'}).`
    : `Tip to tip: also undoes what changed on ${left} after ${right} branched from it.`;
  const toggle = button('link', mb ? 'Compare tips instead' : `Only what ${right} changes`, undefined, mb ? `Compare ${left} and ${right} as they are now` : `Start from the merge base, like git diff ${left}...${right}`);
  toggle.id = 'baseToggle';
  toggle.addEventListener('click', () => send({ type: 'setBase', mergeBase: !mb }));
  baseBar.append(icon(mb ? 'git-merge' : 'arrow-swap'), el('span', undefined, text), toggle);
  // The switch is rebuilt with its new label: keep the keyboard on it.
  if (hadFocus) toggle.focus();
}

function render() {
  if (!data) return;
  title.textContent = data.title;
  // `main...feature`, Git's notation for "from the merge base", when that is what is shown.
  const fromBase = data.base?.mode === 'mergeBase' && !!data.base.mergeBase;
  range.replaceChildren(el('span', 'side', data.left), fromBase ? el('span', 'conn', '...') : icon('arrow-right'), el('span', 'side', data.right));
  renderBase();
  // One lockfile has no file row to open its text diff from: the header has it.
  diffBtn.hidden = !(data.files.length === 1 && data.files[0].origin);
  renderSummary();
  rebuild();
}

// --- interaction ------------------------------------------------------------------

function select(i: number, scroll = true) {
  sel = Math.max(0, Math.min(rows.length - 1, i));
  if (scroll) {
    const y = sel * ROW_H;
    if (y < list.scrollTop) list.scrollTop = y;
    else if (y + ROW_H > list.scrollTop + list.clientHeight) list.scrollTop = y + ROW_H - list.clientHeight;
  }
  paint();
}

function toggle(r: Row) {
  if (r.t !== 'file' && r.t !== 'group') return;
  if (state.collapsed.has(r.key)) state.collapsed.delete(r.key);
  else state.collapsed.add(r.key);
  rebuild(r.key);
}

const ref = (f: FileDiff): FileRef => ({ path: f.path, origin: f.origin });

function act(r: Row, what: string) {
  const file = r.t === 'empty' ? undefined : data!.files[r.fileIdx];
  if (what === 'textDiff') return file && send({ type: 'textDiff', file: ref(file) });
  if (r.t !== 'change' || !file) return;
  const c = r.change;
  if (what === 'open' && c.url) send({ type: 'open', url: c.url });
  if (what === 'reveal') send({ type: 'reveal', file: ref(file), name: c.name, version: c.kind === 'removed' ? c.from : c.to, side: c.kind === 'removed' ? 'left' : 'right' });
}

rowsEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const rowEl = target.closest<HTMLElement>('.row');
  if (!rowEl) return;
  const i = Number(rowEl.dataset.i);
  const r = rows[i];
  const btn = target.closest<HTMLElement>('[data-act]');
  sel = i;
  if (btn) act(r, btn.dataset.act!);
  else if (r.t === 'file' || r.t === 'group') toggle(r);
  else paint();
  list.focus({ preventScroll: true });
});

rowsEl.addEventListener('dblclick', (e) => {
  const rowEl = (e.target as HTMLElement).closest<HTMLElement>('.row');
  if (!rowEl || (e.target as HTMLElement).closest('[data-act]')) return;
  const r = rows[Number(rowEl.dataset.i)];
  if (r?.t === 'change') act(r, 'reveal');
});

list.addEventListener('scroll', () => requestAnimationFrame(paint));
new ResizeObserver(() => paint()).observe(list);

list.addEventListener('keydown', (e) => {
  if (!rows.length) return;
  const r = rows[sel];
  const page = Math.max(1, Math.floor(list.clientHeight / ROW_H) - 1);
  switch (e.key) {
    case 'ArrowDown':
      select(sel + 1);
      break;
    case 'ArrowUp':
      select(sel < 0 ? 0 : sel - 1);
      break;
    case 'PageDown':
      select(sel + page);
      break;
    case 'PageUp':
      select(sel - page);
      break;
    case 'Home':
      select(0);
      break;
    case 'End':
      select(rows.length - 1);
      break;
    case 'ArrowLeft':
      if (r && (r.t === 'file' || r.t === 'group') && !r.collapsed) toggle(r);
      else if (sel >= 0) {
        // To the parent: the nearest row above one level up (a collapsed group's is its file).
        const level = tree[sel].level;
        for (let i = sel - 1; i >= 0; i--) {
          if (tree[i].level < level) {
            select(i);
            break;
          }
        }
      }
      break;
    case 'ArrowRight':
      if (r && (r.t === 'file' || r.t === 'group') && r.collapsed) toggle(r);
      break;
    case 'Enter':
      if (!r) return;
      if (r.t === 'change') act(r, e.shiftKey || e.altKey ? 'reveal' : 'open');
      else if (e.shiftKey || e.altKey) act(r, 'textDiff');
      else toggle(r);
      break;
    case ' ':
      if (r && (r.t === 'file' || r.t === 'group')) toggle(r);
      break;
    default:
      return;
  }
  e.preventDefault();
});

list.addEventListener('focus', () => {
  if (sel < 0 && rows.length) select(rows.findIndex((r) => r.t === 'change') >= 0 ? rows.findIndex((r) => r.t === 'change') : 0);
});

filters.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-filter]');
  if (!b) return;
  state.filter = b.dataset.filter as Filter;
  persist();
  rebuild();
});
filters.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const btns = [...filters.querySelectorAll<HTMLElement>('[data-filter]')];
  const at = btns.findIndex((b) => b.dataset.filter === state.filter);
  const next = btns[(at + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length];
  state.filter = next.dataset.filter as Filter;
  persist();
  rebuild();
  filters.querySelector<HTMLElement>(`[data-filter="${state.filter}"]`)?.focus();
  e.preventDefault();
});

direct.addEventListener('change', () => {
  state.directOnly = direct.checked;
  persist();
  rebuild();
});

let typing: ReturnType<typeof setTimeout> | undefined;
query.addEventListener('input', () => {
  if (typing) clearTimeout(typing);
  typing = setTimeout(() => {
    state.query = query.value;
    persist();
    list.scrollTop = 0;
    rebuild();
  }, 120);
});
query.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && query.value) {
    query.value = '';
    query.dispatchEvent(new Event('input'));
    e.stopPropagation();
  } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
    list.focus();
    e.preventDefault();
  }
});

document.addEventListener('keydown', (e) => {
  const inField = (e.target as HTMLElement).tagName === 'INPUT';
  if ((e.key === '/' && !inField) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f')) {
    query.focus();
    query.select();
    e.preventDefault();
  }
});

copyBtn.addEventListener('click', () => {
  if (!data) return;
  const files = visibleChanges(data.files, state).filter((f) => f.changes.length || f.error);
  const n = files.reduce((k, f) => k + f.changes.length, 0);
  // Never "No dependency changes" for a comparison that has some: the filters hid them.
  if (!n) return;
  const range = `${data.left} → ${data.right}`;
  const text = toMarkdown(files, { range });
  send({ type: 'copy', text, what: `${n} ${n === 1 ? 'change' : 'changes'} as Markdown` });
  copyBtn.classList.add('done');
  copyBtn.querySelector('span')!.textContent = 'Copied';
  setTimeout(() => {
    copyBtn.classList.remove('done');
    copyBtn.querySelector('span')!.textContent = 'Copy as Markdown';
  }, 1500);
});

refreshBtn.addEventListener('click', () => send({ type: 'refresh' }));
diffBtn.addEventListener('click', () => {
  if (data?.files.length === 1) send({ type: 'textDiff', file: ref(data.files[0]) });
});

// --- messages ---------------------------------------------------------------------

let loadingTimer: ReturnType<typeof setTimeout> | undefined;

/** A slow read: the refresh button spins (away from the other controls), and the status says so before there is data. */
function busy(on: boolean) {
  refreshBtn.replaceChildren(icon(on ? 'loading' : 'refresh', on ? 'codicon-modifier-spin' : ''));
  refreshBtn.setAttribute('aria-label', on ? 'Reading lockfiles…' : 'Refresh');
  refreshBtn.title = on ? 'Reading lockfiles…' : 'Refresh';
  if (on && !data) setStatus('Reading lockfiles…');
}

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  if (m.type === 'loading') {
    if (!data) {
      title.textContent = m.title;
      range.replaceChildren(el('span', 'side', m.left), icon('arrow-right'), el('span', 'side', m.right));
    }
    // Only show the spinner for slow reads, so live refreshes don't flicker.
    if (loadingTimer) clearTimeout(loadingTimer);
    loadingTimer = setTimeout(() => busy(true), data ? 600 : 150);
    return;
  }
  if (loadingTimer) clearTimeout(loadingTimer);
  busy(false);
  if (m.type === 'error') {
    data = undefined;
    rows = [];
    summary.replaceChildren(el('span', 'error-text', m.message));
    filters.replaceChildren();
    rowsEl.replaceChildren();
    spacer.style.height = '0';
    // The status is the live region: it carries what went wrong, not only what to do.
    setStatus(`${m.message} Refresh to try again.`);
    copyBtn.disabled = true;
    diffBtn.hidden = true;
    baseBar.hidden = true;
    return;
  }
  if (m.type === 'data') {
    data = m.data;
    // The comparison can change in place (merge base or tips): remember the one shown.
    if (m.request) {
      request = m.request;
      saveState();
    }
    if (m.options && !optionsFromHost) {
      state.filter = m.options.filter;
      state.directOnly = m.options.directOnly;
      optionsFromHost = true;
      saveState();
    }
    render();
  }
});

// Saved right away, so a view nobody touched still comes back after a window reload.
saveState();
send({ type: 'ready' });
