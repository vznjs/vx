# Workstream XP — cross-platform (2026-10-07)

- **XP-20.** `vx watch` compared a cache dir named through a symlink (`VX_CACHE_DIR`, macOS `/var`) with the real paths watchers report, so cache writes ran cycles; the ignore now realpaths it. Row: watch-rules "a cache dir named through a symlink is still the cache (XP-20)".
