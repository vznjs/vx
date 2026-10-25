# vx on GitHub Actions

The starter from `examples/basic`, with the CI setup the
[CI guide](https://vznjs.github.io/vx/docs/ci/) walks through:
`.github/workflows/ci.yml` and `.vx/workspace.ts`. Copy it, then:

```sh
bun install
git init && git add -A && git commit -m init
vx lock          # write .vx/projects.lock.json, then commit it
```

Run `vx lock` again and commit the lock whenever a config, a plugin, a
dependency or a file a config imports changes: CI runs from the lock and
`vx lock --check` fails when it is stale.

`packages/vx/tests/examples.unsafe.test.ts` runs this workflow's steps
as a push to main and as a pull request on every CI run.
