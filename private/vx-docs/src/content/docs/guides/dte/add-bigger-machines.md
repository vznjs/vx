---
title: Give heavy tasks a bigger machine
description: Declare several machine sizes for one worker type, and vx starts the size each task needs.
---

List more than one machine under a worker type. vx learns what each task
uses and starts a bigger machine only for the tasks that need one.

```ts title=".vx/workspace.ts" ins={6}
dte({
  workers: {
    linux: {
      machines: {
        cpu4: { max: 8, cpu: 4, memory: '16GB' },
        cpu16: { max: 2, cpu: 16, memory: '64GB', runsOn: 'ubuntu-latest-16-cores' },
      },
    },
  },
  adapter: github(),
}),
```

`runsOn` names the runner label of a machine. Run `vx dte init` again, and
`vx-worker.yml` sends each size to its runner:

```yaml title=".github/workflows/vx-worker.yml"
    runs-on: ${{ fromJSON('{"linux.cpu4":"ubuntu-latest","linux.cpu16":"ubuntu-latest-16-cores"}')[inputs.size] }}
```

Declare what your runners really have: vx plans by `cpu` and `memory`.
A task that filled its worker last time runs on the bigger size from then on.

---

To run tasks on macOS, add a type whose machine names its platform:

```ts title=".vx/workspace.ts"
mac: { machines: { m1: { max: 2, cpu: 3, memory: '7GB', platform: 'darwin-arm64' } } },
```

`vx dte init` runs it on `macos-latest`. A task with
`exec.platforms: ['darwin-arm64']` runs only there.

See [`@vzn/vx-dte` options](../../../plugins/vx-dte/#api).
