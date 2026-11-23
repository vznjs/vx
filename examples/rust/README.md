# vx with Rust

One crate, `crates/hello`, with `build` (`cargo build --release`),
`test` (`cargo test`) and `lint` (`cargo clippy`). vx needs no plugin for
it: a project is any directory with a `vx.config.ts`. Copy it, then:

```sh
bun install              # installs vx itself, nothing else
vx lock                  # record the configs
git init && git add -A && git commit -m init   # vx reads the tree from git
vx run build test lint --all   # 3 tasks run: local 3↑
vx run build test lint --all   # nothing changed: local 3✓
```

`build` caches the binary, `target/release/hello`. Delete `target/` and
run again: the binary comes back from the cache, nothing compiles.

The keys read `Cargo.lock`, so a dependency change re-runs every task.
After editing a `vx.config.ts`, run `vx lock` and commit the locks. More:
[Quickstart](https://vznjs.github.io/vx/quickstart/).

`packages/vx/tests/examples.live.test.ts` builds and runs this starter
on CI whenever it or vx changes.
