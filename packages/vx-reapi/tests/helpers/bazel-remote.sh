#!/bin/sh
# bazel-remote for `test.live`, in the foreground: pulled from whichever of
# two mirrors answers, two rounds 20 s apart, as nativelink.sh builds. One
# mirror's failed pull was `docker run` exiting 125 before ready (CI,
# 2026-10-26).
set -eu
image=
for round in 1 2; do
  for ref in mirror.gcr.io/buchgr/bazel-remote-cache:latest \
             docker.io/buchgr/bazel-remote-cache:latest; do
    if docker pull -q "$ref" >/dev/null; then image="$ref"; break 2; fi
    echo "docker pull $ref failed (round $round)" >&2
  done
  [ "$round" = 2 ] || sleep 20
done
[ -n "$image" ]
exec docker run --rm -p 19092:9092 -e BAZEL_REMOTE_DIR=/data -e BAZEL_REMOTE_MAX_SIZE=1 \
  -e BAZEL_REMOTE_GRPC_ADDRESS=0.0.0.0:9092 -e BAZEL_REMOTE_HTTP_ADDRESS=0.0.0.0:8080 "$image"
