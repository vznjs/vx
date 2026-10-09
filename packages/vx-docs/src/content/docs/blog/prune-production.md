---
title: 'A runtime image without the dev tools'
date: 2026-10-09T14:00:00Z
authors:
  - vzn
tags:
  - plugins
  - ci
excerpt: 'vx prune --production leaves out the workspace packages only dev dependencies pull in, and strikes them from the copied manifests and lockfile, so the image that runs your app installs frozen without them.'
---

`vx prune` copies one app and the workspace packages it needs, with the
lockfile cut to match. It follows every dependency, dev ones included,
because the build needs them. The image that only runs the built app does
not.

```mermaid
flowchart LR
  A[app] -->|dependencies| L[lib]
  A -.->|devDependencies| T[test-utils]
  L -.->|devDependencies| T
  P[vx prune app --production] --> O[out: app + lib]
```

```text
$ vx prune app --docker --production
vx prune: 2 projects → out (json/ + full/) (production), bun.lock pruned
  app (packages/app)
  lib (packages/lib)
```

`test-utils` stays behind. The copied `package.json` files and the lockfile
no longer name it, so the copy installs with a frozen lockfile under bun,
pnpm, npm and Yarn:

```dockerfile
FROM oven/bun AS run
COPY out/json/ .
RUN bun install --frozen-lockfile --production
COPY out/full/ .
CMD ["bun", "packages/app/dist/index.js"]
```

A package that another field also names (`dependencies`, an optional or a
peer dependency) is installed in production and stays. Third-party dev
dependencies stay in the lockfile; the install's own `--production` flag
skips them.
