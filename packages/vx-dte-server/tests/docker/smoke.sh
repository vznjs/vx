#!/bin/sh
# The relay's image, built and run as `docker run` would, then one run
# carried through it: an orchestrator and a worker join over sockets and
# each hears the other, then the conformance suite every relay passes, then
# a clean stop. Host networking: --no-auth binds loopback only.
set -eu
cd "$(dirname "$0")/../.."
tag="vx-dte-server-smoke:$$"
port=18788
docker build -q -t "$tag" .
name=$(docker run -d --rm --network host "$tag" --no-auth --port "$port")
trap 'docker rm -f "$name" >/dev/null 2>&1; docker rmi -f "$tag" >/dev/null 2>&1' EXIT
ready=
for _ in $(seq 50); do
  if docker logs "$name" 2>&1 | grep -q "vx-dte-server  listening on"; then ready=1; break; fi
  sleep 0.2
done
if [ -z "$ready" ]; then
  echo "vx-dte-server smoke: the container never listened" >&2
  docker logs "$name" >&2 || true
  exit 1
fi
export VX_DTE_RELAY_SMOKE="http://127.0.0.1:$port"
bun tests/docker/smoke.ts
bun test ./tests/docker/conformance.docker.ts
# `docker stop` sends SIGTERM: the relay ends at once and cleanly, never
# killed after Docker's 10 s grace.
started=$(date +%s)
docker stop "$name" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$name" 2>/dev/null || echo gone)
if [ $(( $(date +%s) - started )) -ge 5 ]; then
  echo "vx-dte-server smoke: docker stop took $(( $(date +%s) - started )) s" >&2
  exit 1
fi
echo "vx-dte-server smoke: stopped cleanly ($code)"
