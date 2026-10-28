#!/bin/sh
# The image `docker run` serves, built from the repo root, held to the
# conformance suite every backend passes, then a clean stop (M,
# 2026-10-25: every server runs as Docker, as stable as the relay).
# The bucket is tests/fake-s3.ts, on the host. Host
# networking: the suite's CI issuer listens on the host's loopback.
set -eu
cd "$(dirname "$0")/../.."
tag="vx-cache-server-smoke:$$"
port=18792
issuer_port=18793
s3_port=18794
docker build -q -f Dockerfile -t "$tag" ../.. >/dev/null
export VX_CACHE_SMOKE="http://127.0.0.1:$port"
export VX_CACHE_ISSUER="http://127.0.0.1:$issuer_port"
export VX_CACHE_S3_PORT="$s3_port"
# The issuer serves its keys and a bucket, and writes the ALLOW that names it.
bun tests/docker/issuer.ts >tests/docker/.allow &
issuer=$!
trap 'kill $issuer 2>/dev/null; docker rm -f "${name:-}" >/dev/null 2>&1; docker rmi -f "$tag" >/dev/null 2>&1; rm -f tests/docker/.allow' EXIT
for _ in $(seq 50); do [ -s tests/docker/.allow ] && break; sleep 0.1; done
name=$(docker run -d --network host -e ALLOW="$(cat tests/docker/.allow)" \
  -e S3_BUCKET=b -e S3_ENDPOINT="http://127.0.0.1:$s3_port" -e S3_ACCESS_KEY_ID=a -e S3_SECRET_ACCESS_KEY=s \
  -e MAX_UPLOAD_BYTES=7340032 "$tag" --port "$port" --host 127.0.0.1)
ready=
for _ in $(seq 50); do
  if docker logs "$name" 2>&1 | grep -q "vx-cache-server  listening on"; then ready=1; break; fi
  sleep 0.2
done
if [ -z "$ready" ]; then
  echo "vx-cache-server smoke: the container never listened" >&2
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
  echo "vx-cache-server smoke: docker stop took $(( $(date +%s) - started )) s, exit $code" >&2
  exit 1
fi
echo "vx-cache-server smoke: stopped cleanly"
