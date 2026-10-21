# Security policy

The extension reads lockfiles from your repository and its Git history, runs `git`, and
renders package names and versions in a webview. Bugs that let a lockfile's content run
script in that webview, open links other than registry pages, run programs, or read
files you didn't choose are taken seriously.

## Reporting

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/heyliamme/lockfile-diff/security/advisories/new),
not public issues. Include steps to reproduce. You should hear back within a week.

## Scope

In scope: script execution or HTML injection from lockfile content (package names,
versions, sources), opening a URL that isn't the registry page the extension built,
running Git in an untrusted workspace, passing lockfile content to a shell, and anything
that sends data off the machine.
