# vx with Vite and Vitest

An app and the library it imports: `apps/web` is a Vite app, `packages/ui`
a library built in Vite's library mode. Each has `build` (`vite build`),
`test` (`vitest run`) and `lint` (`oxlint`). Copy it, then:

```sh
bun install
vx lock                  # record the configs and what bun.lock resolves
git init && git add -A && git commit -m init   # vx reads the tree from git
vx run build test lint --all   # 6 tasks run: local 6↑
vx run build test lint --all   # nothing changed: local 6✓
```

Edit `packages/ui/src/index.ts` and run again: `ui` re-runs, and so do
`web#build` and `web#test`, since both depend on `^build`. `web#lint`
reads only web's files, so it stays a hit.

After editing a `vx.config.ts` or installing, run `vx lock` and commit the
locks. More: [Quickstart](https://vznjs.github.io/vx/quickstart/).

`packages/vx/tests/examples.live.test.ts` installs and runs this starter
on CI whenever it or vx changes.
