# Workstream YH — Nx/Turbo parity (2026-10-07)

- **YH-1.** An Nx fileset no file matches (`{projectRoot}/tsconfig.spec.json`, a dependency's unbuilt `*.d.ts`) made its twin print "cache.inputs matched no files" on every miss. A twin now lists its `package.json` first (in every key already, so no key moves). Rows: tests/nx.test.ts › "its twin warns of nothing, and the file appearing still re-keys the reader".
