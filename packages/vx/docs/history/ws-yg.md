# Workstream YG — Nx/Turbo parity (2026-10-07)

- **YG-2.** A hung or down `turboCache()` / `nxCache()` server cost every request its full deadline (30 s per task). Turbo's outage breaker now guards both wires (`src/remote-breaker.ts`): three outages in a row stop requests for 30 s, then one probe. Rows: tests/remote-breaker.test.ts › "a hung server costs three deadlines, not one per request › turboCache()", "… › nxCache()".
