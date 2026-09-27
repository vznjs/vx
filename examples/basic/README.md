# vx starter

Two packages: `app` uses `lib`. Copy it, then:

```sh
npm install
git init && git add -A && git commit -m init   # vx reads the tree from git
npx vx run ci --all      # lib#build, app#build, app#test: 3 miss
npx vx run ci --all      # nothing changed: 3 up-to-date
```

Edit `packages/lib/src/greet.js` and run again: all three re-run, since
`app#build` depends on `^build` and `app#test` on `build`.

Each package's `vx.config.ts` declares its tasks: the command, what runs
first, and the files the cache keys on and restores. More:
[Quickstart](https://vznjs.github.io/vx/quickstart/).

`packages/vx/tests/examples.unsafe.test.ts` runs this starter on every CI
run.
