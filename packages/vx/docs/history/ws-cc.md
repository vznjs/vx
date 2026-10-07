# Workstream CC: cache and remote cache

- **CC-10.** `nxCache()`: a GET answered 403 warned "a read-only token cannot write" — that branch only ever sees a GET, so the cause was always false. It now says the token may not read. Row: `nx-cache-sweep.test.ts` "a GET answering 403 says a read was refused, not a write".
