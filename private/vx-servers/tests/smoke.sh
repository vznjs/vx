#!/bin/sh
# compose.yaml as a user runs it: all three images built, each answering
# on its published port, then a clean stop (2026-10-25: one compose file
# for all vx servers). Each image's own suite is its package's test.live;
# this proves the file wires them.
set -eu
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME="vx-servers-smoke-$$"
export DTE_PORT=18801 CACHE_PORT=18802 HISTORY_PORT=18803
export DTE_ALLOW='https://token.actions.githubusercontent.com:o/r:.github/workflows/ci.yml'
export DTE_AUDIENCE='https://relay.example'
# Its own line: dash expands every word of one export before it sets any,
# so HISTORY_ALLOW="$CACHE_ALLOW" beside it reads an unset name under -u.
export CACHE_ALLOW='https://token.actions.githubusercontent.com:o/r:ci.yml'
export HISTORY_ALLOW="$CACHE_ALLOW"
export CACHE_AUDIENCE="http://127.0.0.1:$CACHE_PORT" HISTORY_AUDIENCE="http://127.0.0.1:$HISTORY_PORT"
export S3_BUCKET=b S3_ENDPOINT='http://127.0.0.1:1' S3_ACCESS_KEY_ID=a S3_SECRET_ACCESS_KEY=s
trap 'docker compose down -v --rmi local >/dev/null 2>&1' EXIT
docker compose up -d --build --quiet-pull
for svc in dte cache history; do
  ready=
  for _ in $(seq 50); do
    if docker compose logs "$svc" 2>&1 | grep -q "vx-$svc-server  listening on"; then ready=1; break; fi
    sleep 0.2
  done
  if [ -z "$ready" ]; then
    echo "vx-servers smoke: $svc never listened" >&2
    docker compose logs "$svc" >&2 || true
    exit 1
  fi
done
for port in $DTE_PORT $CACHE_PORT $HISTORY_PORT; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/v1/capabilities")
  if [ "$code" = 000 ]; then
    echo "vx-servers smoke: nothing answered on :$port" >&2
    exit 1
  fi
done
# `docker compose stop` sends SIGTERM: each server ends at once, never
# killed after Docker's 10 s grace.
started=$(date +%s)
docker compose stop >/dev/null 2>&1
took=$(( $(date +%s) - started ))
codes=$(docker compose ps -a --format '{{.Service}} {{.ExitCode}}' | sort | tr '\n' ' ')
if [ "$took" -ge 5 ] || [ "$codes" != "cache 0 dte 0 history 0 " ]; then
  echo "vx-servers smoke: stop took $took s, exits: $codes" >&2
  exit 1
fi
echo "vx-servers smoke: three servers up and stopped cleanly"
