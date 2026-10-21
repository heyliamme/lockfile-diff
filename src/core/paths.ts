/** Labels for repository roots: the folder name, with as many parents as it takes to tell two apart. */
export function rootLabels(roots: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const segs = roots.map((r) => r.split(/[\\/]/).filter(Boolean));
  roots.forEach((root, i) => {
    let n = 1;
    const label = (k: number) => segs[i].slice(-k).join('/');
    while (n < segs[i].length && roots.some((_, j) => j !== i && segs[j].slice(-n).join('/') === label(n))) n++;
    out.set(root, label(n) || root);
  });
  return out;
}
