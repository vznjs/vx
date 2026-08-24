# A local NativeLink with a shell

NativeLink's official image is distroless — no `/bin/sh` — so a worker inside
it cannot run any REAPI Command whose arguments begin with a shell (which is
every vx task). Rehost the same static musl binary on busybox:

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
