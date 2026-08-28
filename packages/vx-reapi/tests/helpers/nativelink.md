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

Driving `vx run` at a worker needs more than a shell: `git` (vx defers file
enumeration to `git ls-files` and hard-requires it), a JS toolchain, a REAL
Node.js, and — to run vx's OWN suite there — the OS-sandbox tools
(`bubblewrap`, `socat`, `strace`, `ripgrep`). `oven/bun` puts a `node` on PATH that is a SYMLINK TO BUN, and
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
    apt-get update && apt-get install -y --no-install-recommends curl xz-utils ca-certificates git \
      bubblewrap socat strace ripgrep; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${nodearch}.tar.xz" -o /tmp/node.tar.xz; \
    mkdir -p /opt/node; tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1; rm /tmp/node.tar.xz; \
    apt-get purge -y curl xz-utils && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*; \
    git --version; \
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

## Run the container with `--init`

The three `signal handling during vx run (e2e)` cases assert that a signalled
vx kills its child, and they check liveness with `process.kill(pid, 0)` —
which succeeds for a ZOMBIE. With no init as PID 1 there is nothing to reap an
orphan, so the dead child stays visible and the assertion fails on a worker
while passing everywhere else. `docker run --init` supplies the reaper.

That is the whole difference: with `--init` and the sandbox tools in the
image, this repo's ENTIRE suite passes on a worker — 2 594 tests, zero
failures. Every failure seen before that was a worker-image gap or a real gap
in this repo's DECLARED inputs, never the protocol; see "It proves your
declared inputs" in the remote-execution guide.

```sh
docker volume create vx-nl-data
docker run -d --name vx-nativelink --init --privileged -p 50051:50051 \
  -v "$PWD/nativelink-dev.json5:/nativelink.json5:ro" -v vx-nl-data:/nl \
  vx-nativelink:bun-node /nativelink.json5
```

## When it stops answering hits

NativeLink v0.6.0 can degrade into a state where every ActionCache MISS
returns in 3 ms and every HIT never returns: CPU idle, nothing in its logs,
Capabilities answering normally, every stored entry affected. It survives
killing every client, and a plain `docker restart` with identical on-disk data
clears it — so it is in-memory server state, not corruption and not the client.

vx degrades correctly through it (a metadata probe gives up on
`metaTimeoutMs` and the task re-executes rather than failing), so the symptom
is a slow run rather than a red one. Restart the container.
