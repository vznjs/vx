# The reference relay as a container, from the repo root:
#   docker build -t vx-dte-server packages/vx-dte-server
FROM oven/bun:1.4.4-slim
WORKDIR /relay
COPY package.json index.ts PROTOCOL.md ./
# Its one dependency, jose, pinned in package.json; dev ones stay out.
RUN bun install --production --ignore-scripts
COPY src ./src
USER bun
EXPOSE 8080
ENTRYPOINT ["bun", "--no-env-file", "--no-install", "src/bun.ts"]
