# Generated screenshots — do not hand-edit

Every PNG in this directory is produced by the visual-regression suite
(`packages/cloud/tests/visual.test.ts`), which drives the real dashboard — a
built SPA served by a real platform on ephemeral Postgres, seeded through the
real `/v1/ingest` wire — in a real Chromium.

The same files are the suite's **baselines**. So a UI change either fails the
suite as a visual regression, or is accepted by refreshing the baselines, which
updates these docs images in the same commit. Docs screenshots cannot silently
rot behind the product.

```bash
# check for visual regressions (runs as part of the cloud suite)
cd packages/cloud && bun test tests/visual.test.ts

# accept the new look — rewrites these files
cd packages/cloud && VX_UPDATE_SNAPSHOTS=1 bun test tests/visual.test.ts
```

Prerequisites: a built SPA (`vx run build.ui`) and a resolvable Playwright with
a Chromium binary. Without either, the suite **skips** — it never fails a
machine that has no browser.

The capture is deterministic by construction: the seed is anchored to a fixed
epoch, the browser clock is frozen to that same instant (so relative timestamps
render identically forever), and animations are disabled before the shutter.
Baselines are still pinned to the environment that generated them — a different
font set renders different text pixels — so refresh them in the same container
that produced them.
