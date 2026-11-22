---
title: Group tasks under one name
description: Name each tool's task group.technology, and run them all with one group task.
---

Give every task a dotted name: the group first, then the tool. Then one
group task runs them all.

```ts title="packages/web/vx.config.ts" mark={3}
export default {
  tasks: {
    test: { dependsOn: ['test.*'] },
    'test.bun': { exec: { command: 'bun test' } },
    'test.playwright': { exec: { command: 'playwright test' } },
    'test.playwright.smoke': { exec: { command: 'playwright test --grep @smoke' } },
  },
}
```

`test` has no command. It only waits for every task whose name starts
with `test.`, so `vx run test` runs all three:

```sh
vx run test --all --dry
```

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mPlan[0m[4m[58;2;110;118;129m [2m3[0m[4m[58;2;110;118;129m    [2mstatus  cache      usual    time   cpu    mem outputs  blocks worker         task[0m[4m[58;2;110;118;129m                           [0m
            [38;2;6;182;212mrun[0m     [2mno-cache[0m       [2m—[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [38;2;203;213;225m1[0m [2mlocal[0m          [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;232;121;249mtest.bun[0m
            [38;2;6;182;212mrun[0m     [2mno-cache[0m       [2m—[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [38;2;203;213;225m1[0m [2mlocal[0m          [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;96;165;250mtest.playwright[0m
            [38;2;6;182;212mrun[0m     [2mno-cache[0m       [2m—[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [38;2;203;213;225m1[0m [2mlocal[0m          [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mtest.playwright.smoke[0m

  [2mtasks   [0m  [38;2;203;213;225m3 planned · 3 no-cache[0m
```

---

## The naming pattern

Name a task `{group}.{technology}.{configuration}.{subtask}`. Only the
first two parts are required:

| Name | Group | Tool | Configuration |
| --- | --- | --- | --- |
| `build.astro` | `build` | Astro | |
| `lint.oxfmt` | `lint` | oxfmt | |
| `test.bun` | `test` | Bun's test runner | |
| `test.playwright.smoke` | `test` | Playwright | the smoke suite |

Common groups are `build`, `lint`, `test`, `check`, `format` and
`deploy`. Run the group; the dotted tasks are its parts.

---

## Name groups in pipelines

A [pipeline](../../ci/run-a-pipeline/) lists groups only. A new tool
joins CI when you add its dotted task, with no pipeline edit:

```ts title=".vx/workspace.ts"
export default {
  pipelines: {
    pr: { tasks: ['lint', 'test', 'build'], affected: true },
  },
}
```

See [Groups](../../../docs/tasks/#groups).
