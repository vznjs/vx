---
title: 'An upgrade you can trust'
date: 2026-10-09T10:00:00Z
authors:
  - vzn
tags:
  - security
  - dx
excerpt: 'vx upgrade checks npm’s registry signature and the SHA-512 before it replaces anything, upgrades an npm, pnpm, bun or yarn install through that package manager, and swaps back if the new binary does not start. And a CLI that refuses 0x10 instead of guessing.'
---

`vx upgrade` replaces the binary you run. Each step below is checked
before the next, and any failure leaves the old binary in place:

```sh frame="terminal"
$ vx upgrade            # the latest release
$ vx upgrade v0.4.0     # a specific one
```

| Step                                      | If it fails                                  |
| ----------------------------------------- | -------------------------------------------- |
| folder is writable                        | refused before download, prints `sudo` line  |
| npm's registry signature verifies         | nothing replaced                             |
| download matches the SHA-512 npm signed   | nothing replaced                             |
| new binary answers `--version` in 10 s    | old binary swapped back, exit 1              |

npm signs each release's name, version and SHA-512 with a key vx pins.
The server that hands out the file can't make that signature, so a
swapped file is refused. A signature from a key vx doesn't know is
refused too, with a note that vx itself needs updating.

No network, a dead proxy or a captive portal's page prints one line
saying nothing was replaced. On the current version it prints
`already at <version>` and downloads nothing.

## A package manager install goes through it

Installed with a package manager? Then that package manager owns the
file, so `vx upgrade` asks it to do the upgrade and prints the command it
runs: `npm install -g`, `pnpm add -g`, `bun add -g` or `yarn global add`
for a global install, and the project's own manager for a dependency, so
`package.json` and the lockfile change together:

```sh frame="terminal"
$ vx upgrade
› vx upgrade  0.0.635 → 0.0.640

  pnpm add @vzn/vx@0.0.640 --save-dev in /repo
```

vx never installs Node or a package manager for you.

## The version the project pins

A global vx hands every call to the project's own
`@vzn/vx` when the workspace root has one in `node_modules`, so each
repo runs the version its lockfile pins, whatever version is on your
`PATH`. Upgrading a project is then one lockfile change that the whole
team and CI pick up together. `vx upgrade` run there moves both: the
project's dependency first, then the global vx that handed it the
call, to the same version.

```sh frame="terminal"
$ vx --version
vx 0.0.640 (/repo/node_modules/@vzn/vx-linux-x64/vx, handed off from /usr/local/bin/vx)
```

It is one hop and never to itself. It never runs a `node_modules/.bin/vx`
another user owns, since one planted above your checkout would run as you.
The walk stops at the git top-level, like the
[workspace root](../../cli/#the-workspace-root).

One caveat: in a repo you do not trust, a local vx is that repo's code,
the same as its `package.json` scripts. Read a clone before you run
anything in it.

## Who built the bytes

npm's signature proves these are the bytes npm's registry received.
It does not say who built them. For that, every release binary
carries a Sigstore-signed build-provenance attestation naming the
repository, commit and CI workflow that built it:

```sh frame="terminal"
$ gh attestation verify vx-linux-x64 --repo vznjs/vx
```

npm packages are published from CI through trusted publishing, with
provenance attached, so no long-lived npm token exists to steal.

## A CLI that does not guess

Numbers are strict. `0x10`, `1e3` and `2.7` are refused, never read as
something you did not mean, and a misspelled flag names the nearest one:

```sh frame="terminal"
$ vx run build --concurrency 0x10
✗ vx run  --concurrency must be a positive integer, or a share of the cores like '50%' (got 0x10)

  see vx run --help

$ vx run build --timeout 1e3
✗ vx run  --timeout must be a duration like '500ms', '30s' or '5m', at most 24 days (got 1e3)

  see vx run --help

$ vx run build --retry 2
✗ vx run  unknown flag: --retry

  see vx run --help

  fix  --retries
```

`vx help` lists every verb, `vx help <verb>` shows one, and `vx version`
prints the version. The full reference is the [CLI page](../../cli/).
