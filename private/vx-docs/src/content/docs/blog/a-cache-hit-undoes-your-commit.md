---
title: 'Turborepo, Nx and Vite Task undo your commit on a cache hit'
date: 2026-11-10T21:30:00Z
authors:
  - vzn
tags:
  - correctness
  - comparison
excerpt: 'Commit a file that sits in a task’s output folder. On the next cache hit, Turborepo, Nx and Vite Task write the old copy back over it, and the run reports success.'
---

Commit a file that lives in a task's output folder, then build. Turborepo
puts the old copy back and calls it `FULL TURBO`:

```ansi
$ git log -1 --oneline -- packages/site/out/LICENSE
[33maa424fd[m v3
$ turbo run build
   • turbo 2.11.10
   • Packages in scope: site
   • Running build in 1 package
   • Remote caching disabled
[36msite:build: [0mcache hit, replaying logs [2md02065a43c947846[0m
[36msite:build: [0m$ cat src/*.txt > out/index.txt
[1m Tasks:    [32m[1m1 successful[0m, 1 total[0m
[1mCached:    [1m1 cached[0m, 1 total[0m
[1m  Time:    [1m5ms[0m [1m[38;2;18;45;128m>[0m[0;1m[1m[38;2;4;45;162m>[0m[0;1m[1m[38;2;1;45;194m>[0m[0;1m[1m[38;2;6;45;221m [0m[0;1m[1m[38;2;21;45;241mF[0m[0;1m[1m[38;2;44;45;252mU[0m[0;1m[1m[38;2;73;45;254mL[0m[0;1m[1m[38;2;106;45;247mL[0m[0;1m[1m[38;2;141;45;230m [0m[0;1m[1m[38;2;175;45;206mT[0m[0;1m[1m[38;2;205;45;176mU[0m[0;1m[1m[38;2;229;45;142mR[0m[0;1m[1m[38;2;246;45;107mB[0m[0;1m[1m[38;2;254;45;74mO[0m[0;1m[0m[0m
$ git diff --stat
 packages/site/out/LICENSE | 2 [32m+[m[31m-[m
 1 file changed, 1 insertion(+), 1 deletion(-)
```

<small>Turborepo 2.11.10 · `inputs: ["src/**"]`, `outputs: ["out/**"]` · `out/LICENSE` committed · setup warnings cut · 2026-11-10</small>

`out/LICENSE` is source. The build never writes it. The cache kept a
copy anyway, and the hit restored it over your commit.

## Four of six tools lose the commit

| Case                                         | vx   | moon | Turborepo | Nx   | Vite Task | Nix  |
| -------------------------------------------- | ---- | ---- | --------- | ---- | --------- | ---- |
| committed edit under the outputs kept        | pass | pass | fail      | fail | fail      | fail |
| committed `chmod +x` under the outputs kept  | pass | pass | fail      | fail | fail      | fail |
| force-added file under ignored outputs kept  | pass | pass | fail      | fail | fail      | fail |

<small>Turborepo 2.11.10 · Nx 24.0.2 · Vite Task 1.4.0 · moon 2.6.5 · Nix 2.34.6 · [conformance cases](../../conformance/), compiled from the test suites of Nx, Turborepo, Vite Task, moon, Nix and vx</small>

Nix fails another way: it drops `LICENSE` from the tree. The run stays
green in every tool, so nobody sees it until review.

## Where it bites

```mermaid
flowchart LR
  C[you commit out/CNAME] --> H[cache hit for build]
  H -->|restores the entry| O[old out/CNAME]
  O --> D[git diff shows your change reverted]
```

A `CNAME` in the site's output folder, a hand-written `.d.ts` in `dist/`,
a vendored file in `lib/`. Each is tracked by git and sits under an
output glob.

## vx keys what git tracks under the outputs

The same project under vx, after committing a new `out/LICENSE`:

```ansi
$ vx run build --all
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mTasks[0m[4m[58;2;110;118;129m     [2mstatus  cache     ±usual    time   cpu    mem outputs  blocks worker  task[0m
            [38;2;34;197;94msuccess[0m [2mmiss[0m        [38;2;34;197;94m−2ms[0m     [38;2;203;213;225m7ms[0m   [2m29%[0m      [2m—[0m     [2m17B[0m       [2m0[0m [2mlocal[0m  [38;2;167;139;250mpackages/site[0m[2m#[0m[38;2;244;114;182mbuild[0m
$ git diff --stat
$ cat packages/site/out/LICENSE
license v2
```

vx treats a tracked file under an output glob as part of the key. Your
commit changes the key, the task runs, and `LICENSE` stays as committed.

Every case and each tool's detail: [Conformance](../../conformance/).
More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
