# Security model

What vx trusts, what it checks, what the sandbox stops and what it does
not, and how to report a problem. Report a vulnerability privately
through GitHub's private vulnerability reporting on
[vznjs/vx](https://github.com/vznjs/vx/security) (Security → Report a
vulnerability), never in a public issue.

## What vx trusts

- **Your configs.** `vx.config.ts` and `vx.workspace.ts` are programs vx
  runs in its own process. A config can do anything you can: vx
  validates what it returns, not what it does. What a config imports
  must already be installed: vx runs Bun with `--no-install`, so an
  import no `node_modules` provides is refused, never fetched from the
  registry (L-22).
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
  which refuses an artifact a keyholder did not sign.

## What vx checks on bytes it did not write

Every artifact that arrives from a remote, and every one read back from
the local store:

- ends in a CRC-32 of its entries: a byte changed in transit or at rest
  makes the hit a miss, never a replay of the damaged bytes;
- on arrival, records the cache key it was packed under, and is
  refused under another (a local read-back is not re-checked);
- on arrival, carries only the files the task declares as outputs;
- lands each file under the task's project or declared workspace path:
  traversal and names that escape are refused before anything lands, a
  refused archive leaves nothing behind, and links and devices are
  never written;
- is bounded: a decompression bomb, an oversized header or body, and a
  remote answer larger than asked for are refused as they are read.

Remote execution (`@vzn/vx-reapi`) holds each blob to its digest, and
writes a server's outputs only inside the workspace, through no link
that leads out of it.

## What the sandbox stops

A task with `exec.sandbox` runs where only what it declares exists:

- reads of the workspace outside the task's project and grants fail;
- writes outside its `allow.write` grants fail (declared outputs grant
  none);
- the network is closed except to the domains granted, one union per
  run: a task granted any domain reaches every domain the run grants;
- its temp directory and port-bridge socket are its own (mode 0700),
  unreachable from another task and another local user;
- a symlinked output must resolve inside its project: vx packs outputs
  outside the sandbox, and a link to another project's file would have
  carried that file into the cache (L-23).

An undeclared touch of the task's own files fails the task, and a failed
task is never cached. See [Sandboxing tasks](https://vznjs.github.io/vx/guides/sandboxing/).

## What it does not stop

- **A task with no `exec.sandbox`.** It runs with your permissions.
- **Reads outside the workspace root.** `~/.cache`, `/etc` and the like
  stay readable (tools need them) and fold into no key.
- **Resource use.** CPU, memory and disk are bounded by timeouts and the
  artifact ceiling, not by the sandbox.
- **A weaker sandbox where the host cannot nest one**:
  `weakerWhenNested` in a container, a task that itself sandboxes on
  macOS. `vx info` says what the host supports.

## Secrets

The value, of 6 characters or more, of a variable whose name holds
`TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `PASSWD` or `CREDENTIAL` (not one
ending `_FILE`, `_PATH` or `_DIR`, nor `GIT_CONFIG_KEY_<n>`), or that a
task lists in `exec.env.secret`, is printed as `***` wherever vx shows, stores or
exports it: task output, the stdout a hit replays, commands, telemetry
and `vx show`. Values in the run history are digests under a per-store
salt, and what follows `--` on the command line reaches telemetry as a
count, not a quote.

## Releases

Release binaries carry a build-provenance attestation
(`gh attestation verify vx-<target> --repo vznjs/vx`); `vx upgrade`
checks each download's SHA-256 before it replaces anything; npm packages
publish with provenance; and every third-party action in CI runs from a
full commit SHA, held by a test.
