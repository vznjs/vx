# vx servers, one compose file

`compose.yaml` builds and runs vx's three servers from this repo:

| Service   | Port | Package                                                                          |
| --------- | ---- | -------------------------------------------------------------------------------- |
| `dte`     | 8080 | [`@vzn/vx-dte-server`](../../packages/vx-dte-server): the relay of `@vzn/vx-dte` |
| `cache`   | 8081 | [`@vzn/vx-cache-server`](../../packages/vx-cache-server): the remote cache       |
| `history` | 8082 | [`@vzn/vx-history-server`](../../packages/vx-history-server): the task timings   |

```sh
docker compose up -d                 # all three
docker compose up -d cache history   # only the ones you need
```

Each reads its settings from your shell or a `.env` beside the file, as
its README names them: `DTE_ALLOW` and `DTE_AUDIENCE` for the relay (its
`--allow` and `--audience`), `TRUST`, `AUDIENCE`, `READ_ACCESS`, `S3_*`
and `MAX_*` for the cache, `TRUST`, `AUDIENCE`, `READ_ACCESS` and
`TIMING_DAYS` for the timings. The relay stores nothing: after a restart, vx-dte joins
each run in flight again. The timings keep their SQLite file in `history`.
`DTE_PORT`, `CACHE_PORT` and `HISTORY_PORT` move the ports. Put TLS in
front of each: CI tokens are bearer tokens.

`tests/smoke.sh` (`test.live`) brings the file up, checks each server
answers, and stops it.
