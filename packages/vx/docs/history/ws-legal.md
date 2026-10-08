# Workstream LEGAL — licenses and notices (2026-10-08)

- **LEGAL-1.** The platform packages (`@vzn/vx-<target>`) shipped the
  compiled binary alone: no LICENSE, and no notice for what it embeds
  (Bun, with its statically linked LGPL JavaScriptCore, and the bundled
  `@anthropic-ai/sandbox-runtime` (Apache-2.0), `node-forge`
  (BSD-3-Clause), `zod` and `@pondwader/socks5-server` (MIT)), which
  each license requires in every copy. They now carry `LICENSE` and
  `THIRD_PARTY_NOTICES.txt`, generated from the bundle's own inputs and
  the root Bun pin by `scripts/third-party-notices.ts`;
  `tests/third-party-notices.unsafe.test.ts` fails when a dependency
  joins the binary or Bun moves until the file is regenerated. Proven:
  a stale version line and a platform `files` without the two each fail
  a row.
- **LEGAL-2.** The GitHub release assets (what `vx upgrade` and a
  direct download fetch) were bare binaries. `release.upload.linux` now
  attaches `THIRD_PARTY_NOTICES.txt` too; a re-run skips it once
  attached. Proven: `tests/release.test.ts` names it in linux's set.
