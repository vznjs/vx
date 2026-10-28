# The reference relay as a container, from the repo root:
#   docker build -t vx-dte-server packages/vx-dte-server
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
WORKDIR /relay
COPY package.json index.ts PROTOCOL.md ./
# Its one dependency, jose, pinned in package.json; dev ones stay out.
RUN bun install --production --ignore-scripts
COPY src ./src
USER bun
EXPOSE 8080
ENTRYPOINT ["bun", "--no-env-file", "--no-install", "src/bun.ts"]
