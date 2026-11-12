# The reference relay as a container, built from the repo root:
#   docker build -f packages/vx-dte-server/Dockerfile -t vx-dte-server .
# One bundled file: the relay and the CI token check it shares with vx's
# other servers (@vzn/vx-devtools), with jose.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS build
WORKDIR /repo
COPY packages/vx-devtools/package.json packages/vx-devtools/
# jose as @vzn/vx-devtools pins it: the image names no version of its own.
RUN cd packages/vx-devtools && bun install --production --ignore-scripts
COPY packages/vx-devtools/src packages/vx-devtools/src/
COPY packages/vx-dte-server/src packages/vx-dte-server/src/
RUN mkdir -p node_modules/@vzn && ln -s ../../packages/vx-devtools node_modules/@vzn/vx-devtools \
 && bun build packages/vx-dte-server/src/bun.ts --target=bun --outfile=/out/vx-dte-server.js

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
COPY --from=build /out/vx-dte-server.js /app/
USER bun
EXPOSE 8080
ENTRYPOINT ["bun", "--no-env-file", "--no-install", "/app/vx-dte-server.js"]
