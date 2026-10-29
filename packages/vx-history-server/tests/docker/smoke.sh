#!/bin/sh
# The image `docker run` serves, built from the repo root, held to the
# conformance suite every backend passes, then a clean stop (M,
# 2026-10-25: every server runs as Docker, as stable as the relay). Host
# networking: the suite's CI issuer listens on the host's loopback.
set -eu
cd "$(dirname "$0")/../.."
tag="vx-history-server-smoke:$$"
port=18790
issuer_port=18791
docker build -q -f Dockerfile -t "$tag" ../.. >/dev/null
export VX_HISTORY_SMOKE="http://127.0.0.1:$port"
export VX_HISTORY_ISSUER="http://127.0.0.1:$issuer_port"
# The issuer serves its keys and writes the ALLOW that names it.
bun tests/docker/issuer.ts >tests/docker/.allow &
issuer=$!
trap 'kill $issuer 2>/dev/null; docker rm -f "${name:-}" >/dev/null 2>&1; docker rmi -f "$tag" >/dev/null 2>&1; rm -f tests/docker/.allow' EXIT
for _ in $(seq 50); do [ -s tests/docker/.allow ] && break; sleep 0.1; done
name=$(docker run -d --network host -e ALLOW="$(cat tests/docker/.allow)" -e AUDIENCE="$VX_HISTORY_SMOKE" "$tag" --port "$port" --host 127.0.0.1)
ready=
for _ in $(seq 50); do
  if docker logs "$name" 2>&1 | grep -q "vx-history-server  listening on"; then ready=1; break; fi
  sleep 0.2
done
if [ -z "$ready" ]; then
  echo "vx-history-server smoke: the container never listened" >&2
  docker logs "$name" >&2 || true
  exit 1
fi
bun test ./tests/docker/conformance.docker.ts
# `docker stop` sends SIGTERM: the server ends at once, never killed after
# Docker's 10 s grace.
started=$(date +%s)
docker stop "$name" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$name")
if [ $(( $(date +%s) - started )) -ge 5 ] || [ "$code" != 0 ]; then
  echo "vx-history-server smoke: docker stop took $(( $(date +%s) - started )) s, exit $code" >&2
  exit 1
fi
echo "vx-history-server smoke: stopped cleanly"
