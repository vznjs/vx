// Shared mitata wrapper. Keeps each module's *.bench.ts file tiny —
// it just declares scenarios; running + reporting lives here. Future
// work: write JSON results out to `bench/baselines/` for CI gating.

import { run } from 'mitata'

export async function runBench(): Promise<void> {
  await run({
    colors: process.stdout.isTTY,
    format: 'mitata',
  })
}
