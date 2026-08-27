# A local NativeLink for vx remote execution

NativeLink's official image is distroless — no `/bin/sh` — so a worker inside
it cannot run any REAPI Command whose arguments begin with a shell (which is
every vx task). Rehost the same static musl binary on a base that has one.

## The minimal rehost (what CI uses)

For the e2e suites, busybox is enough:

```sh
docker create --name nl-x ghcr.io/tracemachina/nativelink:v0.6.0 /x
docker cp -L nl-x:/bin/nativelink ./nativelink && docker rm nl-x
printf 'FROM public.ecr.aws/docker/library/busybox:musl\nCOPY nativelink /usr/local/bin/nativelink\nENTRYPOINT ["/usr/local/bin/nativelink"]\n' > Dockerfile
docker build -t vx-nativelink-sh .
docker run -d --name vx-nl -p 51051:50051 -v "$PWD/exec.json5:/config.json5" vx-nativelink-sh /config.json5

VX_REAPI_EXEC_ENDPOINT=127.0.0.1:51051 bun test tests/exec-e2e.test.ts
```

`exec.json5` is the all-in-one config (CAS + AC + scheduler + one local
worker); the copy CI uses lives at `tests/helpers/nativelink-exec.json5`.

## A worker that can run this repo's own tasks

Driving `vx run` at a worker needs more than a shell: a JS toolchain, and a
REAL Node.js. `oven/bun` puts a `node` on PATH that is a SYMLINK TO BUN, and
bun is not a drop-in — the `node_modules/.bin` shims are
`#!/usr/bin/env node` scripts, and silently running them under a different
runtime fails in ways that read as bugs in the tool. Install the official
build:

```dockerfile
FROM oven/bun:1.4

ARG NODE_VERSION=22.14.0
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in arm64) nodearch=arm64 ;; amd64) nodearch=x64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; esac; \
    apt-get update && apt-get install -y --no-install-recommends curl xz-utils ca-certificates; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${nodearch}.tar.xz" -o /tmp/node.tar.xz; \
    mkdir -p /opt/node; tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1; rm /tmp/node.tar.xz; \
    apt-get purge -y curl xz-utils && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*; \
    /opt/node/bin/node --version

# /usr/local/bin, not just PATH: a REAPI worker runs each action with its OWN
# minimal environment, so the image's PATH never reaches the command. That
# directory IS on the worker's default PATH, which is why the link belongs
# there — setting ENV PATH alone leaves the action seeing bun's fallback.
RUN ln -sf /opt/node/bin/node /usr/local/bin/node \
 && ln -sf /opt/node/bin/npm /usr/local/bin/npm \
 && ln -sf /opt/node/bin/npx /usr/local/bin/npx
ENV PATH=/opt/node/bin:$PATH

COPY nativelink /usr/local/bin/nativelink
ENTRYPOINT ["/usr/local/bin/nativelink"]
```

Bake it into the image. Installing node into a RUNNING container works and
then vanishes the moment the container is recreated, which looks exactly like
a regression in vx.

## Storage: not `/tmp`, and not the memory stores

For a real install-as-an-action workload, use FILESYSTEM stores with room for
a `node_modules` tree — the memory stores in `nativelink-exec.json5` are sized
for the e2e suites and evict under that load, which surfaces mid-action as
`Object <digest> not found in either fast or slow store`.

Put the data on a docker VOLUME, not a `/tmp` bind mount. macOS prunes `/tmp`,
and it does so a directory at a time: a server whose shard directories are
half-deleted answers writes with
`unexpected error opening temp file: … no such file or directory`, and a
mounted config file that has been removed comes back as an empty DIRECTORY,
which the server then refuses to parse.

```sh
docker volume create vx-nl-data
docker run -d --name vx-nativelink -p 50051:50051 \
  -v "$PWD/nativelink-dev.json5:/nativelink.json5:ro" -v vx-nl-data:/nl \
  vx-nativelink:bun-node /nativelink.json5
```
