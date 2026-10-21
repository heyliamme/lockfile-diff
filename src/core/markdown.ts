import { count, emptyCounts } from './diff';
import type { Change, Counts } from './types';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 added, 1 removed, 12 upgraded (1 major)". */
export function summarize(c: Counts): string {
  const parts: string[] = [];
  if (c.added) parts.push(`${c.added} added`);
  if (c.removed) parts.push(`${c.removed} removed`);
  if (c.upgraded) parts.push(`${c.upgraded} upgraded${c.major ? ` (${c.major} major)` : ''}`);
  if (c.downgraded) parts.push(`${c.downgraded} downgraded`);
  if (c.changed) parts.push(`${c.changed} changed`);
  return parts.length ? parts.join(', ') : 'No dependency changes';
}

export function sumCounts(list: Counts[]): Counts {
  const out = emptyCounts();
  for (const c of list) for (const k of Object.keys(out) as (keyof Counts)[]) out[k] += c[k];
  return out;
}

/** One line of a table cell: no line breaks, pipes escaped. */
const cell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n\u2028\u2029]+/g, ' ');
/**
 * Text from a lockfile as plain text: Markdown and HTML syntax escaped, so a crafted name
 * can't turn into a link, a heading or a closing tag in the pull request.
 */
const text = (s: string) => cell(s).replace(/[`*_[\]()<>#!~&]/g, '\\$&');
/** A code span in a table: one line, pipes escaped (GFM reads `\|` inside code in tables), no backticks. */
const code = (s: string) => (s ? `\`${s.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\|/g, '\\|').replace(/`/g, "'")}\`` : '');
/** Names the extension links: what registries allow, nothing that could end a link early. */
const linkable = (name: string) => /^[\w@./+-]+$/.test(name);

function changeText(c: Change): string {
  const dir = c.kind === 'upgraded' ? 'upgrade' : 'downgrade';
  if (c.kind === 'upgraded' || c.kind === 'downgraded') {
    if (c.flag === 'breaking') return `breaking ${dir} (0.x)`;
    if (c.flag === 'commit') return `${c.kind === 'upgraded' ? 'newer' : 'older'} commit${c.why ? `: ${c.why}` : ''}`;
    const base = c.bump && c.bump !== 'other' ? `${c.bump} ${dir}` : c.kind;
    return c.flag === 'v0' ? `${base} (v0)` : base;
  }
  return c.kind;
}

/** `^17.0.2 → ^18.2.0`, `(new) → ^3`. */
export function rangeText(r: { from?: string; to?: string }): string {
  return `${r.from ?? '(new)'} → ${r.to ?? '(removed)'}`;
}

export interface MarkdownOptions {
  /** "main → Working Tree": the side labels, shown as plain text (a ref name can hold `<!--`). */
  range?: string;
  /** Wrap tables longer than this in a collapsed <details> block. */
  collapseAfter?: number;
}

/** A Markdown summary for a pull request description or a review comment. */
export function toMarkdown(files: { path: string; changes: Change[]; error?: string; directKnown?: boolean; warnings?: string[] }[], opts: MarkdownOptions = {}): string {
  const collapseAfter = opts.collapseAfter ?? 25;
  const all = files.flatMap((f) => f.changes);
  const lines: string[] = [`### Dependency changes`, ''];
  lines.push(`${summarize(count(all))}${opts.range ? ` (${text(opts.range)})` : ''}.`, '');
  for (const f of files) {
    if (files.length > 1 || f.error) lines.push(`**${text(f.path)}**: ${f.error ? text(f.error) : summarize(count(f.changes))}`, '');
    for (const w of f.warnings ?? []) lines.push(`> **Warning:** ${text(w)}`, '');
    if (!f.changes.length) continue;
    const declared = f.changes.some((c) => c.range);
    const table = [`| Package | Change | From | To |${declared ? ' Declared |' : ''}`, `| --- | --- | --- | --- |${declared ? ' --- |' : ''}`];
    for (const c of f.changes) {
      const tags = [c.direct === true ? 'direct' : '', c.dev ? 'dev' : '', c.alias ? `as ${c.alias}` : ''].filter(Boolean);
      const name = `${c.url && linkable(c.name) ? `[${text(c.name)}](${c.url})` : text(c.name)}${tags.length ? ` (${tags.map(text).join(', ')})` : ''}`;
      const change = `${text(changeText(c))}${c.note ? `, ${text(c.note)}` : ''}`;
      table.push(`| ${name} | ${change} | ${code(c.from ?? '')} | ${code(c.to ?? '')} |${declared ? ` ${c.range ? code(rangeText(c.range)) : ''} |` : ''}`);
    }
    if (f.changes.length > collapseAfter) lines.push(`<details><summary>${plural(f.changes.length, 'change')}</summary>`, '', ...table, '', '</details>', '');
    else lines.push(...table, '');
  }
  return lines.join('\n').trimEnd() + '\n';
}
