#!/bin/sh
# The relay's image, built and run as `docker run` would, then one run
# carried through it: an orchestrator and a worker join over sockets and
# each hears the other. Host networking: --no-auth binds loopback only.
set -eu
cd "$(dirname "$0")/../.."
tag="vx-dte-relay-smoke:$$"
port=18788
docker build -q -t "$tag" .
name=$(docker run -d --rm --network host "$tag" --no-auth --port "$port")
trap 'docker rm -f "$name" >/dev/null 2>&1; docker rmi -f "$tag" >/dev/null 2>&1' EXIT
ready=
for _ in $(seq 50); do
  if docker logs "$name" 2>&1 | grep -q "vx-dte-relay on"; then ready=1; break; fi
  sleep 0.2
done
if [ -z "$ready" ]; then
  echo "vx-dte-relay smoke: the container never listened" >&2
  docker logs "$name" >&2 || true
  exit 1
fi
VX_DTE_RELAY_SMOKE="http://127.0.0.1:$port" bun tests/docker/smoke.ts
