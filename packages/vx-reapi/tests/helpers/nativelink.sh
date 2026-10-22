#!/bin/sh
# NativeLink for `test.live`, in the foreground: rehosted on busybox
# (nativelink.md says why), from whichever of three mirrors answers, two
# rounds 20 s apart, then run until the run stops it.
set -eu
config="$(cd "$(dirname "$0")" && pwd)/nativelink-exec.json5"
work="$(mktemp -d)"
cd "$work"
docker create --name "nl-x-$$" ghcr.io/tracemachina/nativelink:v0.6.0 /x >/dev/null
docker cp -L "nl-x-$$:/bin/nativelink" nativelink-bin
docker rm "nl-x-$$" >/dev/null
built=
for round in 1 2; do
  for base in public.ecr.aws/docker/library/busybox:musl \
              mirror.gcr.io/library/busybox:musl \
              docker.io/library/busybox:musl; do
    printf 'FROM %s\nCOPY nativelink-bin /usr/local/bin/nativelink\nENTRYPOINT ["/usr/local/bin/nativelink"]\n' "$base" > Dockerfile.nl
    if docker build -q -f Dockerfile.nl -t vx-nativelink-sh . >/dev/null; then built=1; break 2; fi
    echo "docker build from $base failed (round $round)" >&2
  done
  [ "$round" = 2 ] || sleep 20
done
[ -n "$built" ]
exec docker run --rm -p 51051:50051 -v "$config:/config.json5" vx-nativelink-sh /config.json5
