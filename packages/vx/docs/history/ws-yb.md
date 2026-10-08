# Workstream YB — Nx/Turbo parity (2026-10-07)

- **YB-3.** fix: vercel/vercel's tests read `turbo-platform-cache-key.json` through `{ mode: "dependencyOutputs" }` from `//#generate:cache-keys` (`cache: false`, records the host); vx folded only the producer's key, so a test cached on one platform hit on another. The files from an uncached producer are a workspace probe, and the producer is left out of `inputs.tasks` so the probe is answered after it ran. Rows: `turbo-dependency-outputs.test.ts` › "keys a task on what an uncached producer wrote this run".
