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
epoch, **both** clocks are frozen to that same instant — the browser's (so
relative timestamps render identically forever) and the platform's, so every
windowed analytics read sees the seeded window — and animations are disabled
before the shutter.

Freezing only the browser gave these images a roughly one-week shelf life:
"this 7 days" was computed from the server's real clock, so it walked off the
seeded data and the published dashboard gradually emptied out. Measured at 31
days past the fixture epoch, the project page rendered `AVG EXEC <1ms · RUNS 0 ·
CACHE HIT RATE 0%` where the truth was `717ms · 21 · 37%`. Both clocks are
frozen now, so a refresh is stable until the UI itself changes.

Baselines are still pinned to the environment that generated them — a different
font set renders different text pixels — so refresh them in the same container
that produced them.
