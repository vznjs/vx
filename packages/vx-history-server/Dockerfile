# vx-history-server as a container, built from the repo root:
#   docker build -f packages/vx-history-server/Dockerfile -t vx-history-server .
#   docker run -p 8080:8080 -v vx-history:/data -e ALLOW='https://token.actions.githubusercontent.com:acme/app:ci.yml' vx-history-server
# One bundled file: the server and the CI token check it shares with
# vx's other servers (@vzn/vx-devtools), with jose.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS build
WORKDIR /repo
COPY packages/vx-devtools/package.json packages/vx-devtools/
COPY packages/vx-devtools/src packages/vx-devtools/src/
COPY packages/vx-history-server/src packages/vx-history-server/src/
RUN echo '{}' > package.json \
 && bun add jose@6.2.13 \
 && mkdir -p node_modules/@vzn && ln -s ../../packages/vx-devtools node_modules/@vzn/vx-devtools \
 && bun build packages/vx-history-server/src/bun.ts --target=bun --outfile=/out/vx-history-server.js

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
COPY --from=build /out/vx-history-server.js /app/
RUN mkdir /data && chown bun /data
USER bun
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["bun", "--no-env-file", "--no-install", "/app/vx-history-server.js", "--db", "/data/vx-history.sqlite"]
