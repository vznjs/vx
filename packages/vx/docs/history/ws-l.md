# Workstream L — security findings (plan 2026-09-27): the record

## Audit

1. Tar reader and restore. Traversal (`..`, absolute, backslash, drive,
   NUL, long names), links in the tree (lexical + realpath walk, dangling
   links resolved, rename over a planted link) and zstd bombs (declared
   size, multi-frame, running count) were already held. Found: an
   extended header is read whole with no bound (L-1).

## Items

- L-1. `fix(cache)`: an extended header (`x`, `L`, `g`) is read whole, so
  its declared size was a claim on memory the stream never paid for: a
  1 GiB pax header (~32 KB as zstd) peaked at 2 GiB RSS where a 1 GiB
  regular entry streams in 32 MiB, under the 2 GiB ceiling. Now refused
  past 1 MiB before its body is read; a pax `size` that is not a whole
  number (`0.5` moved the reader to a fractional offset) is refused too.
  Rows in `tar-stream.test.ts`, red without the fix.
- L-3. `fix(vx-reapi)`: a CAS read was checked against its digest's size
  only once whole: a zstd batch entry or ByteStream reply was expanded to
  its frame's end (256 MiB from ~8 KB), and a body that never ends was
  collected until memory ran out. The size is now held as bytes arrive,
  zstd is decoded no further than the size, and a batch entry is held to
  the digest asked for (one not asked for is dropped). Rows in
  `read-bounds.test.ts`.

## Leads for other streams
