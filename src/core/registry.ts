import type { Ecosystem } from './types';

/** Hosts a registry link may point at. The extension opens nothing else. */
export const REGISTRY_HOSTS = ['www.npmjs.com', 'pub.dev', 'crates.io', 'pypi.org', 'pkg.go.dev', 'packagist.org', 'rubygems.org'];

export const REGISTRY_NAMES: Record<Ecosystem, string> = {
  npm: 'npm',
  pub: 'pub.dev',
  pypi: 'PyPI',
  cargo: 'crates.io',
  go: 'pkg.go.dev',
  packagist: 'Packagist',
  rubygems: 'RubyGems',
};

const enc = encodeURIComponent;
/** Keeps the slashes of scoped and path-like names: `@types/node`, `github.com/a/b`. */
const path = (name: string) => name.split('/').map(enc).join('/').replace(/^%40/, '@');
/** Only real versions go into a URL; a git commit or tarball URL links to the package page. */
const plain = (v: string | undefined) => (v && /^[\w.+!~-]+$/.test(v) ? v : undefined);

/** The package's page on its registry, at `version` when that is a plain version. */
export function registryUrl(ecosystem: Ecosystem, name: string, version?: string): string | undefined {
  if (!name || /[\s<>"'`]/.test(name)) return undefined;
  const v = plain(version);
  switch (ecosystem) {
    case 'npm':
      return `https://www.npmjs.com/package/${path(name)}${v ? `/v/${enc(v)}` : ''}`;
    case 'pub':
      return `https://pub.dev/packages/${enc(name)}${v ? `/versions/${enc(v)}` : ''}`;
    case 'cargo':
      return `https://crates.io/crates/${enc(name)}${v ? `/${enc(v)}` : ''}`;
    case 'pypi':
      return `https://pypi.org/project/${enc(name)}/${v ? `${enc(v)}/` : ''}`;
    case 'go':
      return `https://pkg.go.dev/${path(name)}${v ? `@${enc(v)}` : ''}`;
    case 'packagist':
      return /^[\w.-]+\/[\w.-]+$/.test(name) ? `https://packagist.org/packages/${path(name)}` : undefined;
    case 'rubygems':
      return `https://rubygems.org/gems/${enc(name)}${v ? `/versions/${enc(v)}` : ''}`;
  }
}

/** True for a URL the extension built itself: https, on a known registry host. */
export function isRegistryUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && REGISTRY_HOSTS.includes(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}
