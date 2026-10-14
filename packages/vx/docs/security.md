# Security model

What vx trusts, what it checks, what the sandbox stops and what it does
not, and how to report a problem. Report a vulnerability privately
through GitHub's private vulnerability reporting on
[vznjs/vx](https://github.com/vznjs/vx/security) (Security → Report a
vulnerability), never in a public issue.

## What vx trusts

- **Your configs.** `vx.config.ts` and `vx.workspace.ts` are programs vx
  runs in its own process. A config can do anything you can: vx
  validates what it returns, not what it does. The workspace root is
  the nearest `vx.workspace.*`, and vx never looks for it above the git
  top-level, so a file planted in a shared directory such as `/tmp`
  cannot claim your checkout and run as you. Outside git, one another
  user owns is refused, root aside (`tests/workspace-root-file.test.ts`).
  What a config imports
  must already be installed: vx runs Bun with `--no-install`, so an
  import no `node_modules` provides is refused, never fetched from the
  registry (L-22).
- **Your project's own vx.** A global vx hands every call to the
  workspace root's `node_modules/.bin/vx` (cli.md § Which vx runs), so even
  `vx --version` in a repo you do not trust runs that repo's code. One
  another user owns is never run.
- **Your plugins.** A plugin is code you imported. It runs in vx's
  process with a config's reach; vx checks the shape of what it hands
  back and isolates a telemetry plugin's failures, nothing more.
- **Your lockfile and your repo.** vx parses a lockfile (and
  `turbo.json` or an Nx graph when migrating) into keys and refuses one
  it cannot read, naming the file. A lockfile that names another
  install is a different key, never a code path.
- **Whoever can write your remote cache.** A cache key names the
  inputs, not the bytes, so a store that answers a key with bytes of its
  choosing is trusted as a writer, as it is in every action cache. Use a
  store only your builds write to, or `turboCache()`'s signature key,
  which refuses an artifact a keyholder did not sign. A job you do not
  trust (a fork's pull request) reads at most: `--cache-policy=local:rw,remote:r`,
  or the tools' own `TURBO_REMOTE_CACHE_READ_ONLY`, `TURBO_CACHE` and
  `NX_SKIP_REMOTE_CACHE`, which the cache plugins honour (L-34).

## Cache poisoning

A pull request that can write the cache the default branch reads can
plant bytes main later replays (CREEP, CVE-2025-36852). The boundary is
the credential, enforced by the cache server: the default branch's job
holds a token that writes the default keys, and a pull request's job
holds one that cannot (read-only, or confined by the server to its own
namespace), or none.

`cache.scope` is the client half. `'pr-123'` reads the default keys,
then its own, and writes only its own, which `github()` sets on
Actions (`pr-<n>`, `ref-<name>`; the default branch sets none)
and `VX_CACHE_SCOPE` or `--cache-scope` sets on any CI. Whether a run
writes is `cache.policy`'s call: off CI the default reads the remote and
writes nothing, since a key holds only declared inputs and a laptop's
undeclared tool or file would replay on CI. A laptop that should never
write gets a read-only token too. The local cache follows the same
key rule, so on one disk a PR's entries sit under its scope's keys and
a persistent runner never serves them to main.
It keeps honest runs apart and stops a non-hermetic PR build from
landing where main reads; it is not a boundary, since the PR's own
config decides it and any run holding a write credential can write any
key.

A boundary the server holds, with bazel-remote and `@vzn/vx-reapi`: reads
are open, writes need a password, and only main's push job has it.

```sh
htpasswd -cB /etc/bazel-remote/htpasswd ci   # the write credential
bazel-remote --dir /data --max_size 50 --grpc_address 0.0.0.0:9092 \
  --htpasswd_file /etc/bazel-remote/htpasswd --allow_unauthenticated_reads
```

```ts
// vx.workspace.ts: the header only where the secret is set
reapi({
  endpoint: 'grpcs://cache.example.com:9092',
  headers: process.env.CACHE_AUTH ? { authorization: `Basic ${process.env.CACHE_AUTH}` } : {},
})
```

```yaml
# .github/workflows/ci.yml: CACHE_AUTH (base64 of ci:<password>) is a
# secret of the `cache-write` environment, whose only deployment branch
# is main, so no other branch's workflow can read it
jobs:
  build:
    if: github.event_name != 'push' || github.ref != 'refs/heads/main'
    steps:
      - run: vx run build --all
  build-main:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    environment: cache-write
    env:
      CACHE_AUTH: ${{ secrets.CACHE_AUTH }}
    steps:
      - run: vx run build --all
```

A pull request's job has no `CACHE_AUTH`, so the server refuses its
writes whatever its config says. Never give the write secret to a
`pull_request_target`, `issue_comment` or `workflow_run` job that checks
out a pull request's code: it runs with main's ref and secrets, and
`github()` scopes it `pr-<n>` only on the client side.

A boundary that holds whoever can write the store is a signing cache
plugin: main's CI signs each upload, and a reader refuses, as it streams,
a download no trusted key signed, so the hit is a miss. Core needs no
change for it; the plugins guide (§ Your own cache › Signed artifacts) has a
complete one, run by `tests/signed-cache-guide.unsafe.test.ts`.

## What vx checks on bytes it did not write

Every artifact that arrives from a remote, and every one read back from
the local store:

- ends in a CRC-32 of its entries: a byte changed in transit or at rest
  makes the hit a miss, never a replay of the damaged bytes;
- on arrival, records the cache key it was packed under, and is
  refused under another (a local read-back is not re-checked);
- on arrival, carries only the files the task declares as outputs;
- lands each file under the task's project or declared workspace path:
  traversal (`..`, `.`, absolute names) is refused before anything
  lands, a refused archive leaves nothing behind, and links and devices
  are never written; a seeded fuzz of hostile archives holds this;
- is bounded: a decompression bomb, an oversized header or body, and a
  remote answer larger than asked for are refused as they are read.

Remote execution (`@vzn/vx-reapi`) holds each blob to its digest, and
writes only the server's outputs a declared glob names, inside the
workspace, through no link that leads out of it, and through no link
into a place no declared glob names.

## What the sandbox stops

A task with `exec.sandbox` runs where only what it declares exists:

- reads of the workspace outside the task's project and grants fail;
- writes outside its `allow.write` grants fail (declared outputs grant
  none);
- the network is closed except to the domains granted, one union per
  run: a task granted any domain reaches every domain the run grants;
  with none, it reaches no listener on the host's loopback and no unix
  socket outside the workspace (L-46);
- its temp directory, port-bridge socket and trace log are its own
  (mode 0700), unreachable from another task and another local user;
- the host's credential stores (`~/.ssh`, `~/.gnupg`, `~/.aws`,
  `~/.npmrc`, `~/.netrc`, the token files of deploy and agent CLIs such
  as Vercel, Wrangler, Fly or Claude, and the like; the list is in the
  schema's sandbox section) are unreadable unless `allow.read` names one
  (L-41), cannot be hard-linked into an output for vx to pack, and a denied read's `fix:` hint never suggests granting one
  (`tests/sandbox-credential-stores.unsafe.test.ts`, `tests/sandbox-fix.test.ts`);
- vx's own cache directory, wherever `cache.dir` puts it in the
  workspace, is a wall like `.vx`: a broad grant stops at it, and a write
  grant that would bind it is refused (L-24);
- a symlinked output must resolve inside its project: vx packs outputs
  outside the sandbox, and a link to another project's file would have
  carried that file into the cache (L-23). An output directory linked out
  of the project refuses the task by name (X-88). Inside the project, a
  link must name a file the task could read (a read or write grant, its
  `node_modules`) or one of its own outputs, so `dist/x -> ../.env` under
  `read: ['src/']` is refused, and Linux judges making the link by the
  link, never its target (`tests/sandbox-output-link.unsafe.test.ts`).
- vx's own environment, which holds the variables a task is not given
  (a token, a key), is unreadable: the task cannot see vx's
  `/proc/<pid>/environ` on Linux or read it through `ps eww` on macOS
  (`tests/sandbox-parent-env.unsafe.test.ts`).

An undeclared touch of the task's own files fails the task, and a failed
task is never cached. See [Sandboxing tasks](https://vznjs.github.io/vx/guides/sandboxing/).

The sandbox costs each task it runs; a cache hit runs nothing and costs
nothing. `tests/sandbox-parent-env.unsafe.test.ts` prints the cost of one
`true` task, min of 20, on every CI run. On GitHub-hosted runners on
2026-10-13 it printed +269 ms on Linux and +97 ms on macOS.

## What it does not stop

- **A task with no `exec.sandbox`.** It runs with your permissions:
  it reads anything you can. vx hides its own environment from it on
  every command: on Linux vx makes itself non-dumpable (about 0.8 ms), on
  macOS it zeroes the values `ps eww` reads, every variable but the
  essentials every task gets (about 0.7 ms). It starts its helpers with `PATH`
  alone and each `git` with only what git reads
  (`tests/hide-env.unsafe.test.ts`, `tests/git-env.test.ts`). That hides
  the environment only, not files.
- **Reads outside the workspace root.** `~/.cache`, `/etc` and the like
  stay readable (tools need them) and fold into no key. The credential
  stores under home (`~/.ssh`, `~/.aws`, `~/.npmrc` and the like) are
  not: a task reads one only when its `allow.read` names it (L-41).
- **Resource use.** CPU, memory and disk are bounded by timeouts and the
  artifact ceiling, not by the sandbox.
- **A weaker sandbox where the host cannot nest one**:
  `weakerWhenNested` in a container, a task that itself sandboxes on
  macOS. `vx info` says what the host supports.

## Agents (`vx mcp`)

An agent connected to `vx mcp` can do what `vx run` can do, nothing more.
Every tool but `runTasks` only reads. `runTasks` runs `vx run --format json`
as a child process: the agent names tasks and sets `all`, `force`,
`filter` and `affected`, and nothing else. A task name that starts with
`-` is refused, a filter goes as one `--filter=` value, and a ref reaches
git after `--end-of-options`, so no argument becomes a flag. The commands
that run are the ones your configs declare, from the workspace root, with
the environment `vx mcp` started with, filtered by each task's `exec.env`
and held by its `exec.sandbox`. `force` costs a rerun, not a wrong entry:
the key stays the same. What reaches the agent (summaries, refusals,
`getFailures` output) is masked as described under Secrets.
`mcp({ run: false })` takes `runTasks` away, and `mcp({ run: ['test'] })`
limits it to those task names. An agent that
can edit `vx.config.ts` can run anything, as you can, because configs are
code vx trusts.

## Secrets

The value, of 6 characters or more, of a variable whose name holds
`TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `PASSWD` or `CREDENTIAL` (not one
ending `_FILE`, `_PATH` or `_DIR`, nor `GIT_CONFIG_KEY_<n>`), or that a
task lists in `exec.env.secret`, and the password of a URL
(`scheme://user:<password>@`) in any variable's value, is printed as `***` wherever vx shows, stores or
exports it: task output, the stdout a hit replays, commands, an
executor's error, telemetry,
`vx show` and `vx mcp`'s `listTasks` (L-26). Values in the run history are digests under a per-store
salt, and what follows `--` on the command line reaches telemetry as a
count, not a quote, a secret before it masked (L-44). A remote executor (`@vzn/vx-reapi`) receives a
task's `exec.env.define` values and the `cache.inputs.env` values its
local child gets, never `passThrough`; those values sit unmasked in the
action's Command, which the remote stores in its CAS, as Bazel's
`--action_env` does, so a secret a remote task needs is trusted to that
remote. `vx lock` refuses to write a lock holding a secret value: the lock is
committed (L-42).

Masking covers the text vx shows and stores, not a task's outputs: they
are cached and uploaded as the task wrote them, so a build that bakes a
secret into a file (a server bundle reading `process.env.API_KEY`) hands
it to every reader of the remote cache. Keep secrets out of cached
outputs, or give that task no `cache`. vx does not scan outputs for
secret values: a name-based match would refuse public `*_KEY` values too.

## Releases

Release binaries carry a build-provenance attestation
(`gh attestation verify vx-<target> --repo vznjs/vx`); `vx upgrade`
installs a binary only after npm's registry signature over the platform
package's `name@version:integrity` verifies against npm's key, pinned
in vx, and the tarball matches that integrity: the host that serves the
bytes cannot make the signature, so a swapped tarball is refused before
anything is written, and a key id vx does not pin is refused with a hint
that the installer needs updating (owner, 2026-10-13; pnpm's installer
checks the same). The new binary is staged in a fresh directory, never a
name another user could plant a link at. A vx a package manager
installed is upgraded by that manager, which checks its own integrity.
npm packages
publish with provenance; every third-party action in CI runs from a
full commit SHA; and a workflow hands an event's or a dispatcher's value
to a script through `env`, never pasted in (a release tag is checked as a
version first); every workflow names its token's permissions, and CI's
is read-only. A test holds each rule.
