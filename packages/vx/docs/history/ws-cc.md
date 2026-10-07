# Workstream CC: cache and remote cache

- **CC-7.** `turboCache()` took only 200 and 202 as a stored upload; a
  Turbo-compatible server answering 201 or 204 stored the artifact while vx
  warned and counted a failed upload. Any 2xx now succeeds, as Turbo's own
  client (`error_for_status`) reads it. Row: turbo-cache-sweep "any 2xx is
  stored, as for turbo; a 3xx or 4xx is not".
