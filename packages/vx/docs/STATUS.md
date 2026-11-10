# STATUS

Direction and what is next. Edit it only when one of them changes. A
merged change is recorded in its PR and change file, not here. The file
as it stood until 2026-11-10 is `docs/history/2026-11-status-archive.md`.

## Direction (2026-11-10)

- **Solid as rock first.** A stale hit, data loss, crash or leak is the
  worst failure. Hardening runs until days pass with no serious find.
- **Seen as the best.** vx wins every time number against Turbo, Nx and
  Vite Task (only CPU may lose, and only to Vite Task), and passes every
  conformance case it can run. Every claim carries proof.
- **Interest, not adoption.** Pre-1.0, breaking changes ship outright,
  with no alias or shim.
- **Strong core, everything else a plugin.** The one distribution
  exception is `@vzn/vx-dte`.

## Next (ordered)

1. **Keep main green.** A red push on main is fixed before new work.
2. **Hardening to days with no serious find.** Each serious find also
   becomes a conformance case; the suite grows past 2,000.
3. **Real-repo proof.** Well-known OSS monorepos, native config, run in
   our own workspace, total times on the site.
4. **Widen the narrow wins.** The no-op margin over Turbo, and this
   repo's CI to 2 minutes.
5. **Fewer, sharper posts,** each led by a hard result.
