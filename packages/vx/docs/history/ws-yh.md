# Workstream YH — Nx/Turbo parity (2026-10-07)

- **YH-1.** An Nx fileset no file matches (`{projectRoot}/tsconfig.spec.json`, a dependency's unbuilt `*.d.ts`) made its twin print "cache.inputs matched no files" on every miss. A twin now lists `package.json` and `project.json` first (a project has one; Nx keys on both). Rows: tests/nx.test.ts › "its twin (with %s alone) warns of nothing, and the file appearing still re-keys the reader".
