# Workstream L — security findings (plan 2026-09-27): the record

## Audit

1. Tar reader and restore. Traversal (`..`, absolute, backslash, drive,
   NUL, long names), links in the tree (lexical + realpath walk, dangling
   links resolved, rename over a planted link) and zstd bombs (declared
   size, multi-frame, running count) were already held. Found: an
   extended header is read whole with no bound (L-1).
2. Remote inputs. Core's ingest holds (names, links, bombs, key check).
   vx-reapi's materialise wrote a server's ActionResult anywhere (L-2).

## Items

- L-1. `fix(cache)`: an extended header (`x`, `L`, `g`) is read whole, so
  its declared size was a claim on memory the stream never paid for: a
  1 GiB pax header (~32 KB as zstd) peaked at 2 GiB RSS where a 1 GiB
  regular entry streams in 32 MiB, under the 2 GiB ceiling. Now refused
  past 1 MiB before its body is read; a pax `size` that is not a whole
  number (`0.5` moved the reader to a fractional offset) is refused too.
  Rows in `tar-stream.test.ts`, red without the fix.
- L-2. `fix(vx-reapi)`: materialise joined a server's ActionResult paths
  and Tree names as given, so a hostile or broken server (a fresh result
  or a replayed record) wrote outside the workspace: `../..` or absolute
  paths, a Tree name `..`, a link it placed followed by a directory
  written through it, a file written through a link standing at its
  path, and setuid bits kept. Every path is now fenced to the workspace
  root (lexical, then the deepest existing ancestor's real path), a link
  whose target leaves the workspace is refused, an output file is
  written `O_NOFOLLOW` (a link there is replaced), and a mode keeps its
  permission bits only. Rows in `materialise-fence.test.ts`.
- L-3. `fix(vx-reapi)`: a CAS read was checked against its digest's size
  only once whole: a zstd batch entry or ByteStream reply was expanded to
  its frame's end (256 MiB from ~8 KB), and a body that never ends was
  collected until memory ran out. The size is now held as bytes arrive,
  zstd is decoded no further than the size, and a batch entry is held to
  the digest asked for (one not asked for is dropped). Rows in
  `read-bounds.test.ts`.
- L-5. `fix(cache)`: `ingest` wrote a remote body to its temp with no
  bound, so a body that never ends (turbo, nx or reapi remote) filled the
  disk before the decode's ceiling saw a byte. The compressed body is now
  held to the ceiling's zstd bound (length header, Blob size, running
  count on a stream). Cost: 4.4 ms per 64 MiB streamed (min of 7).
  Row in `artifact-ceiling.test.ts`.
- L-6. `fix(exec)`: SRT reads its `socket(AF_UNIX)` lift from the
  run-wide config, so one task's `unixSockets` or `localBinding` port list
  lifted it for every sandboxed task of the run: a task that declared no
  socket connected to a host unix socket (docker's, ssh-agent's) once a
  sibling did (probed: `socket(1, 1, 0): Operation not permitted` alone,
  the host socket reached beside a granted task). The lift is now set for
  each task's own wrap, wraps taken one at a time, and only in a run
  where some task asks. Row in `sandbox-runtime.unsafe.test.ts`.

## Leads for other streams

- B (sandbox), PROVEN by probe: every sandboxed task shares SRT's
  writable `/tmp/claude`, where the task tmpdirs (`vx-task-*`) and the
  port-bridge sockets (`vx-port-<tag>-<port>.sock`) live. Task b ran
  `cat /tmp/claude/*/secret` and printed what a concurrent task a wrote to
  its own `$TMPDIR`: a cross-project read, and b could as well replace a's
  bridge socket. A per-task `denyRead` of `/tmp/claude` plus the task's
  own dir as a write grant does not take: SRT's default write path
  re-binds it (tried, L review). Needs SRT driven differently (a private
  tmpfs per task, or SRT's tmp dir pointed per task).
- B (sandbox), from the L review, unproven by probe:
  - `weakerWhenNested` makes SRT bind the host's `/proc` (read in SRT's
    source). Probed on this box as root: the task saw only its own pid
    namespace (pids 1, 2, 6) and `environ` was denied, so no leak here;
    a box where the weaker profile is the one that runs is unprobed.
  - Strace logs (`os.tmpdir()/vx-strace-<tag>.log`) are readable by a
    concurrent task: every path another task opened.
  - A write grant's realpath is checked before bwrap mounts it; a
    concurrent task that can write the parent may swap in a link between.
- D (config): the purity gate lets `new Worker('./x.ts')` through; the
  worker's file is outside the hashed closure, so its reads (env, clock)
  can be cached stale.
- G (adoption): `turboCache()` with a signature key writes the whole
  remote body to its temp before verifying the tag, with no byte bound
  (core's ingest bound, L-5, comes after); `hasMany` reads its JSON reply
  unbounded.
