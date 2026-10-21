/** Whether the entry starting at line `i` names `version` within its first lines (a blank line ends it). */
function mentions(lines: string[], i: number, version: string): boolean {
  for (let j = i; j < Math.min(lines.length, i + 6); j++) {
    if (j > i && !lines[j].trim()) return false;
    if (lines[j].includes(version)) return true;
  }
  return false;
}

/** The line where a package's entry starts, by the common shapes lockfiles write names in. */
export function findEntry(text: string, name: string, version?: string): number {
  const lines = text.split('\n');
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '\\\\?/'); // composer.lock writes "psr\/log"
  const shapes = [
    new RegExp(`"node_modules/(?:.*/node_modules/)?${esc}"\\s*:`), // npm v2/v3
    new RegExp(`^\\s*"?'?/?${esc}[@/]`), // yarn, pnpm, bun keys
    new RegExp(`^name = "${esc}"`, 'i'), // Cargo, Poetry, uv
    new RegExp(`^ {2}${esc}:\\s*$`), // pubspec.lock
    new RegExp(`^ {4}${esc} \\(`), // Gemfile.lock
    new RegExp(`"name":\\s*"${esc}"`), // composer.lock
    new RegExp(`^\\s*"${esc}"\\s*:\\s*[{[]`), // npm v1, bun
    new RegExp(`^\\s*(?:require\\s+)?${esc}\\s+v`), // go.mod, go.sum
  ];
  let first = -1;
  for (const re of shapes) {
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      if (first < 0) first = i;
      // Prefer the entry that mentions the version within its first lines.
      if (!version || mentions(lines, i, version.split('@')[0])) return i;
    }
    if (first >= 0) return first;
  }
  return 0;
}
