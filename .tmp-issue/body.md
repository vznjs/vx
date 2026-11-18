Hey Nx team 👋

I work on [vx](https://vznjs.github.io/vx/), an open source task runner for JS monorepos. While building it we put together a conformance suite for task runners: https://vznjs.github.io/vx/conformance/

Each case is a tiny workspace, run sandboxed against Nx, Turbo, vx, Vite Task, moon and Nix. Only outcomes count: which commands ran, the files left on disk, the exit code. The cases come from the test suites of all six tools, yours included.

Nx 24.0.2 passes 653 of 1014. 63 more are behaviours Nx has no way to express, so they are left out here. Below are the 298 it fails. Each link opens the case, with what Nx did and why we think the expected result is right.

I'm sharing this as a favor, not a demand. A few questions:

- Is one list like this OK, or would you rather have separate issues? I didn't want to open 300 issues you may not consider issues.
- If you don't see some of these as bugs, or don't plan to fix them, that's completely fine. It's up to you.
- If a case drives Nx the wrong way, tell me and we fix the suite.
- Want to contribute? New cases you have found are very welcome, and so are fixes to the Nx adapter. It all lives in [private/vx-conformance](https://github.com/vznjs/vx/tree/main/private/vx-conformance).


### Task graph (22)

- [ ] [A task that depends on itself fails the run](https://vznjs.github.io/vx/conformance/#j4guwx) `j4guwx`
- [ ] [A glob matches across the scope’s `/`: `*core*` selects `@acme/core`](https://vznjs.github.io/vx/conformance/#9sdepe) `9sdepe`
- [ ] [Excluding `*utils` takes out the scoped `@acme/utils`](https://vznjs.github.io/vx/conformance/#819een) `819een`
- [ ] [A selector that matches no project fails the run](https://vznjs.github.io/vx/conformance/#ded2g6) `ded2g6`
- [ ] [What a run builds on a skipped, out-of-date dependency never replays in a full run](https://vznjs.github.io/vx/conformance/#pzqng5) `pzqng5`
- [ ] [Two selected tasks keep their order when the task between them is skipped](https://vznjs.github.io/vx/conformance/#edgwlb) `edgwlb`
- [ ] [A task on `build.*` reruns when a matched task’s input changes](https://vznjs.github.io/vx/conformance/#osyu3y) `osyu3y`
- [ ] [A selection its excludes leave empty, beside a selector matching nothing, fails the run](https://vznjs.github.io/vx/conformance/#i6rwf5) `i6rwf5`
- [ ] [A project whose directory holds spaces and parentheses runs there, caches and restores](https://vznjs.github.io/vx/conformance/#02etfh) `02etfh`
- [ ] [With dependencies skipped, a test behind an unchanged server replays and no server starts](https://vznjs.github.io/vx/conformance/#m2vx9r) `m2vx9r`
- [ ] [Args forwarded to a server reach it as typed, never expanded by a shell](https://vznjs.github.io/vx/conformance/#rfzn7d) `rfzn7d`
- [ ] [A workspace package linked under another name is a dependency: its build runs first](https://vznjs.github.io/vx/conformance/#5q1vzj) `5q1vzj`
- [ ] [dependsOn naming another project’s task that does not exist fails before any runs](https://vznjs.github.io/vx/conformance/#dr3qhf) `dr3qhf`
- [ ] [dependsOn naming a task its own project lacks fails before any runs](https://vznjs.github.io/vx/conformance/#64cuuj) `64cuuj`
- [ ] [A `^build` ring that passes through a project without a build still fails](https://vznjs.github.io/vx/conformance/#zxayh5) `zxayh5`
- [ ] [`^build.*` across a package cycle does not wrap back to the asking project’s own tasks](https://vznjs.github.io/vx/conformance/#djxhs9) `djxhs9`
- [ ] [A task named like a route, `t--src/app/\[id\]/page`, is one name in dependsOn](https://vznjs.github.io/vx/conformance/#dmrgy4) `dmrgy4`
- [ ] [In `t--src/app/\[id\]/*` the brackets are characters, not a class](https://vznjs.github.io/vx/conformance/#sbrytn) `sbrytn`
- [ ] [A git worktree checked out inside the workspace adds no project to a run](https://vznjs.github.io/vx/conformance/#7kw4d8) `7kw4d8`
- [ ] [A server the run no longer needs is asked to stop politely, so its cleanup runs](https://vznjs.github.io/vx/conformance/#fkw67u) `fkw67u`
- [ ] [A server-style task that finishes with exit 0 before its ready line lets its dependants run](https://vznjs.github.io/vx/conformance/#6xfanu) `6xfanu`
- [ ] [Running a task in a named project that does not declare it fails](https://vznjs.github.io/vx/conformance/#au0h4u) `au0h4u`

### Config (6)

- [ ] [`*` alone in dependsOn fails the run](https://vznjs.github.io/vx/conformance/#6r07fh) `6r07fh`
- [ ] [`^*` alone in dependsOn fails the run](https://vznjs.github.io/vx/conformance/#we730x) `we730x`
- [ ] [`**` alone in dependsOn fails the run](https://vznjs.github.io/vx/conformance/#hfcnoj) `hfcnoj`
- [ ] [dependsOn naming a task the project lacks fails the run](https://vznjs.github.io/vx/conformance/#2698n4) `2698n4`
- [ ] [dependsOn naming a project that does not exist fails the run](https://vznjs.github.io/vx/conformance/#oeeogt) `oeeogt`
- [ ] [dependsOn naming a task another project lacks fails the run](https://vznjs.github.io/vx/conformance/#z5hh04) `z5hh04`

### Failures (19)

- [ ] [Asking for two tasks, one of which no project declares, fails the run](https://vznjs.github.io/vx/conformance/#1yawbh) `1yawbh`
- [ ] [Asking for a task in a project that does not declare it fails the run](https://vznjs.github.io/vx/conformance/#ewdu21) `ewdu21`
- [ ] [A closed terminal lets a process a task backgrounded run its cleanup](https://vznjs.github.io/vx/conformance/#zclwc0) `zclwc0`
- [ ] [Running a task no project declares fails instead of passing with nothing run](https://vznjs.github.io/vx/conformance/#v6bwep) `v6bwep`
- [ ] [Asking for a task no project declares fails the run](https://vznjs.github.io/vx/conformance/#u8j0fg) `u8j0fg`
- [ ] [Ctrl-\ (SIGQUIT) ends the run, its task, and what the task backgrounded](https://vznjs.github.io/vx/conformance/#vlcu29) `vlcu29`
- [ ] [SIGINT to the run reaches a running task as SIGINT](https://vznjs.github.io/vx/conformance/#mlzkso) `mlzkso`
- [ ] [SIGTERM to the run reaches a running task as SIGTERM](https://vznjs.github.io/vx/conformance/#kr80ck) `kr80ck`
- [ ] [One Ctrl-C lets a task finish its cleanup](https://vznjs.github.io/vx/conformance/#kk8p4y) `kk8p4y`
- [ ] [A process a task backgrounded gets to clean up on SIGTERM after the task’s shell has died](https://vznjs.github.io/vx/conformance/#qvcb2s) `qvcb2s`
- [ ] [A run started with SIGHUP ignored (nohup) runs on when the terminal closes](https://vznjs.github.io/vx/conformance/#ml4fko) `ml4fko`
- [ ] [A task that reads its input stream sees it end, though the runner’s own stays open, and the run finishes](https://vznjs.github.io/vx/conformance/#xajok4) `xajok4`
- [ ] [SIGINT to the run reaches a server past its ready line as SIGINT](https://vznjs.github.io/vx/conformance/#8aiqrm) `8aiqrm`
- [ ] [SIGTERM to the run reaches a server past its ready line as SIGTERM](https://vznjs.github.io/vx/conformance/#vso9fy) `vso9fy`
- [ ] [One Ctrl-C lets a ready server finish its cleanup while its dependant is stopped](https://vznjs.github.io/vx/conformance/#z1t8kg) `z1t8kg`
- [ ] [A server that exits non-zero as it starts fails the run instead of hanging it](https://vznjs.github.io/vx/conformance/#y4uz5q) `y4uz5q`
- [ ] [A server whose shell exits leaves nothing it started holding its port](https://vznjs.github.io/vx/conformance/#mqjryk) `mqjryk`
- [ ] [SIGINT to the run reaches a running server as SIGINT](https://vznjs.github.io/vx/conformance/#lo69sh) `lo69sh`
- [ ] [SIGTERM to the run reaches a running server as SIGTERM](https://vznjs.github.io/vx/conformance/#8xpi2i) `8xpi2i`

### Affected (41)

- [ ] [A change selects a project whose task names the changed project’s task](https://vznjs.github.io/vx/conformance/#ckezeq) `ckezeq`
- [ ] [A committed dependency change selects the projects whose dependencies hold it, through a linked workspace too, and no other](https://vznjs.github.io/vx/conformance/#lr6a1p) `lr6a1p`
- [ ] [A committed edit inside a local directory dependency selects the project depending on it](https://vznjs.github.io/vx/conformance/#9djbc7) `9djbc7`
- [ ] [A committed edit to a local dependency kept inside another project’s directory selects the project depending on it](https://vznjs.github.io/vx/conformance/#tl9l21) `tl9l21`
- [ ] [A committed change selects its project and every project that depends on it](https://vznjs.github.io/vx/conformance/#uxurvb) `uxurvb`
- [ ] [A deleted file counts as a change to its project](https://vznjs.github.io/vx/conformance/#cg6lim) `cg6lim`
- [ ] [An uncommitted edit selects its project and every project that depends on it](https://vznjs.github.io/vx/conformance/#qqij1o) `qqij1o`
- [ ] [Changing a project’s task definition selects it and its dependents](https://vznjs.github.io/vx/conformance/#mnigds) `mnigds`
- [ ] [A base several commits back selects what every commit since changed](https://vznjs.github.io/vx/conformance/#z2dnwr) `z2dnwr`
- [ ] [In a depth-2 clone, the previous commit as base selects the change and its dependents](https://vznjs.github.io/vx/conformance/#wbldsk) `wbldsk`
- [ ] [In a depth-1 clone, the previous commit as base is fetched and selects the change](https://vznjs.github.io/vx/conformance/#f058eu) `f058eu`
- [ ] [In a depth-1 clone of a branch, the base branch on origin selects what the branch changed](https://vznjs.github.io/vx/conformance/#kd7ftm) `kd7ftm`
- [ ] [In a depth-1 merge checkout, the first parent as base selects what the merge brought in](https://vznjs.github.io/vx/conformance/#myi8sv) `myi8sv`
- [ ] [An edit to a file marked assume-unchanged in git’s index selects its project](https://vznjs.github.io/vx/conformance/#uv14kd) `uv14kd`
- [ ] [An edit to a file marked skip-worktree in git’s index selects its project](https://vznjs.github.io/vx/conformance/#uaqtds) `uaqtds`
- [ ] [Deleting a file marked assume-unchanged selects its project](https://vznjs.github.io/vx/conformance/#b6irm4) `b6irm4`
- [ ] [An edit to the file an input link points at selects the link’s project](https://vznjs.github.io/vx/conformance/#bkywqz) `bkywqz`
- [ ] [An edit inside the directory an input link points at selects the link’s project](https://vznjs.github.io/vx/conformance/#2cmwfb) `2cmwfb`
- [ ] [A new file in the directory an input link points at selects the link’s project](https://vznjs.github.io/vx/conformance/#sxqjq9) `sxqjq9`
- [ ] [An edit to a git-ignored file an input link points at selects the link’s project](https://vznjs.github.io/vx/conformance/#7jmesk) `7jmesk`
- [ ] [An affected run of a task no project declares fails, whatever changed](https://vznjs.github.io/vx/conformance/#vid3zz) `vid3zz`
- [ ] [An edit inside a submodule project selects it](https://vznjs.github.io/vx/conformance/#0swey0) `0swey0`
- [ ] [A new untracked file inside a submodule project selects it](https://vznjs.github.io/vx/conformance/#gqakav) `gqakav`
- [ ] [Moving a submodule to another commit selects it, committed or not](https://vznjs.github.io/vx/conformance/#c9pkc7) `c9pkc7`
- [ ] [A submodule `.gitmodules` tells git to ignore still selects its project when it changes](https://vznjs.github.io/vx/conformance/#cfp3fk) `cfp3fk`
- [ ] [An edit to a file committed under a `node_modules` directory selects its project](https://vznjs.github.io/vx/conformance/#78l66y) `78l66y`
- [ ] [Deleting a whole project selects none of the projects that remain](https://vznjs.github.io/vx/conformance/#5jp2nq) `5jp2nq`
- [ ] [A project moved to another directory is selected where it now lives](https://vznjs.github.io/vx/conformance/#iqdwoo) `iqdwoo`
- [ ] [Making a directory inside a project a project of its own selects both](https://vznjs.github.io/vx/conformance/#lgbn2z) `lgbn2z`
- [ ] [A base naming a directory inside a commit (`HEAD:packages`) selects nothing unchanged](https://vznjs.github.io/vx/conformance/#czpokq) `czpokq`
- [ ] [A base written as an exclusion (`^main`) selects nothing only the base branch changed](https://vznjs.github.io/vx/conformance/#p09l8n) `p09l8n`
- [ ] [An edit or a bump in a submodule selects its project though git is set to ignore it](https://vznjs.github.io/vx/conformance/#hylhey) `hylhey`
- [ ] [A `chmod +x` selects its project though git’s `core.fileMode` is off](https://vznjs.github.io/vx/conformance/#ypqq4p) `ypqq4p`
- [ ] [A same-size rewrite that keeps its mtime selects its project under `core.checkStat=minimal`](https://vznjs.github.io/vx/conformance/#5pu6u6) `5pu6u6`
- [ ] [An input glob spelled `./src/**` selects on an edit under src/](https://vznjs.github.io/vx/conformance/#es7463) `es7463`
- [ ] [A task that only aggregates others runs when a task it depends on is affected](https://vznjs.github.io/vx/conformance/#ifo3lw) `ifo3lw`
- [ ] [A task named `toString` is declared only where it is written](https://vznjs.github.io/vx/conformance/#0hxbv0) `0hxbv0`
- [ ] [A task reaches a change through either arm of a diamond of task edges](https://vznjs.github.io/vx/conformance/#hixpf2) `hixpf2`
- [ ] [An edit inside a nested repository a root input reaches selects the task naming it](https://vznjs.github.io/vx/conformance/#8auf1c) `8auf1c`
- [ ] [An edit behind a directory link selects a task whose `src/**/*.txt` reaches through it](https://vznjs.github.io/vx/conformance/#nlqa9j) `nlqa9j`
- [ ] [An edit behind a root directory link selects a task whose root input reaches through it](https://vznjs.github.io/vx/conformance/#x9va15) `x9va15`

### Inputs (121)

- [ ] [Making an input executable runs the task again](https://vznjs.github.io/vx/conformance/#ih56uy) `ih56uy`
- [ ] [Making the file an input link points at executable runs the task again](https://vznjs.github.io/vx/conformance/#nm1cp6) `nm1cp6`
- [ ] [A task that lists no inputs never replays a stale result when a file it reads changes](https://vznjs.github.io/vx/conformance/#vfjhu1) `vfjhu1`
- [ ] [A task that lists no inputs never replays a stale result when a variable it reads changes](https://vznjs.github.io/vx/conformance/#6asagn) `6asagn`
- [ ] [An input `{src,lib}` keys every file under both directories](https://vznjs.github.io/vx/conformance/#2mkmwy) `2mkmwy`
- [ ] [An input `{./src,lib}/**` keys files under `src`](https://vznjs.github.io/vx/conformance/#4qnz0b) `4qnz0b`
- [ ] [An input `{.,src}/*.txt` keys a `.txt` file at the project’s top](https://vznjs.github.io/vx/conformance/#rsnelr) `rsnelr`
- [ ] [An input written `./src/**` keys the files under `src`](https://vznjs.github.io/vx/conformance/#sg5xyj) `sg5xyj`
- [ ] [A negation written `!./gen/**` takes `gen` back out of the inputs](https://vznjs.github.io/vx/conformance/#r1q1w9) `r1q1w9`
- [ ] [An input `*/.` names each top directory’s whole tree](https://vznjs.github.io/vx/conformance/#9i802c) `9i802c`
- [ ] [A committed file under a nested `node_modules` is an input like any other](https://vznjs.github.io/vx/conformance/#h8k7rt) `h8k7rt`
- [ ] [A gitignored file named outright in the inputs is an input](https://vznjs.github.io/vx/conformance/#xnun5a) `xnun5a`
- [ ] [A gitignored directory named outright in the inputs keys every file under it](https://vznjs.github.io/vx/conformance/#7lq73m) `7lq73m`
- [ ] [A gitignored root file named outright in the root inputs is an input](https://vznjs.github.io/vx/conformance/#lq8g9k) `lq8g9k`
- [ ] [A root file the task writes is not its own input, though a root input glob covers it](https://vznjs.github.io/vx/conformance/#p878wm) `p878wm`
- [ ] [A root input glob over the task’s own project does not key its own outputs](https://vznjs.github.io/vx/conformance/#b7s3u4) `b7s3u4`
- [ ] [A variable keying an uncached dependency reruns its cached dependant when it changes](https://vznjs.github.io/vx/conformance/#mr27g6) `mr27g6`
- [ ] [A root file keying an uncached dependency reruns its cached dependant when edited](https://vznjs.github.io/vx/conformance/#tw4i04) `tw4i04`
- [ ] [An uncached dependency that lists no inputs never lets its dependant replay a stale result](https://vznjs.github.io/vx/conformance/#zxkuin) `zxkuin`
- [ ] [A file keying a same-project dependency reruns the task that depends on it](https://vznjs.github.io/vx/conformance/#w0zqyz) `w0zqyz`
- [ ] [A task rewriting its own input ahead of a reader leaves the reader’s output current](https://vznjs.github.io/vx/conformance/#n4i72w) `n4i72w`
- [ ] [A task depending on another project’s named task rebuilds when that task’s output changes](https://vznjs.github.io/vx/conformance/#faxqfz) `faxqfz`
- [ ] [A result built from an input another task edited mid-run is not replayed once the input is put back](https://vznjs.github.io/vx/conformance/#hzuwhf) `hzuwhf`
- [ ] [Tasks built over a dependency whose input was edited mid-run are not replayed once it is put back](https://vznjs.github.io/vx/conformance/#hire4k) `hire4k`
- [ ] [A key command that exits non-zero fails the run without running the task](https://vznjs.github.io/vx/conformance/#qxifkp) `qxifkp`
- [ ] [A key command two projects share is run once per run](https://vznjs.github.io/vx/conformance/#lc9cv1) `lc9cv1`
- [ ] [A key command reading a dependency’s output answers after that dependency ran](https://vznjs.github.io/vx/conformance/#t8d5qz) `t8d5qz`
- [ ] [A root output inside the task’s own project is not its own input, though its inputs cover it](https://vznjs.github.io/vx/conformance/#tuwbhw) `tuwbhw`
- [ ] [A gitignored file `gen` named in the inputs is keyed beside a tracked `gen-notes.txt`](https://vznjs.github.io/vx/conformance/#wv3ngy) `wv3ngy`
- [ ] [A key command reading a file an uncached dependency rewrites answers after it ran](https://vznjs.github.io/vx/conformance/#gp321t) `gp321t`
- [ ] [With git's `core.trustctime=false`, a same-size edit that keeps its mtime runs the task again](https://vznjs.github.io/vx/conformance/#qhfr9p) `qhfr9p`
- [ ] [With git's `core.checkStat=minimal`, a same-size edit that keeps its mtime runs the task again](https://vznjs.github.io/vx/conformance/#v5mhlf) `v5mhlf`
- [ ] [An edit to a committed input whose name is not UTF-8 never replays the old build](https://vznjs.github.io/vx/conformance/#g7t2e5) `g7t2e5`
- [ ] [An edit to an untracked input whose name is not UTF-8 never replays the old build](https://vznjs.github.io/vx/conformance/#oygqce) `oygqce`
- [ ] [An edit to a root input whose name is not UTF-8 never replays the old build](https://vznjs.github.io/vx/conformance/#qp4vza) `qp4vza`
- [ ] [A task whose inputs cover another task’s output never replays a build of that output’s old bytes](https://vznjs.github.io/vx/conformance/#1xk3b2) `1xk3b2`
- [ ] [Edits behind an input directory that is a link, and behind a linked root input directory, rerun](https://vznjs.github.io/vx/conformance/#ox0n4m) `ox0n4m`
- [ ] [Edits behind links below a glob’s fixed directory, one of them never committed, rerun](https://vznjs.github.io/vx/conformance/#dsl1sl) `dsl1sl`
- [ ] [An edit behind a brace alternative’s directory that is a link reruns](https://vznjs.github.io/vx/conformance/#5mdyep) `5mdyep`
- [ ] [An edit behind a link inside a gitignored input directory reruns](https://vznjs.github.io/vx/conformance/#keocy3) `keocy3`
- [ ] [An edit behind an input link to a file outside the project reruns](https://vznjs.github.io/vx/conformance/#9b160x) `9b160x`
- [ ] [An edit to a gitignored file an input link points at reruns](https://vznjs.github.io/vx/conformance/#df2su6) `df2su6`
- [ ] [An edit, and then a new file, behind a linked input directory rerun](https://vznjs.github.io/vx/conformance/#9d6g6r) `9d6g6r`
- [ ] [An edit behind a link found inside a linked input directory reruns](https://vznjs.github.io/vx/conformance/#w0cut3) `w0cut3`
- [ ] [A same-size edit that keeps the file’s modification time runs the task again](https://vznjs.github.io/vx/conformance/#ihgh3g) `ihgh3g`
- [ ] [A same-size edit within the same whole-second stamp as the first write runs the task again](https://vznjs.github.io/vx/conformance/#mx2nmj) `mx2nmj`
- [ ] [An input edited while the task runs is not replayed under the key of the bytes before](https://vznjs.github.io/vx/conformance/#cec074) `cec074`
- [ ] [A file a nested repository tracks despite its own ignore rule is an input](https://vznjs.github.io/vx/conformance/#9jw900) `9jw900`
- [ ] [An input glob over a nested project never replays a stale result](https://vznjs.github.io/vx/conformance/#3ceogl) `3ceogl`
- [ ] [An input naming a file of a nested project never replays a stale result](https://vznjs.github.io/vx/conformance/#zdoo41) `zdoo41`
- [ ] [A brace input reaching a nested project never replays a stale result](https://vznjs.github.io/vx/conformance/#jqmj4o) `jqmj4o`
- [ ] [Pointing a dangling input link at another missing target runs the task again](https://vznjs.github.io/vx/conformance/#p16q1e) `p16q1e`
- [ ] [Named pipes under the input and output globs neither hang the run nor stop a replay](https://vznjs.github.io/vx/conformance/#n6uqyx) `n6uqyx`
- [ ] [A gitignored input named outright keys its creation, each edit, and its removal](https://vznjs.github.io/vx/conformance/#mkyysn) `mkyysn`
- [ ] [An input `gen/**` keys every file under the gitignored directory `gen`](https://vznjs.github.io/vx/conformance/#qniuw9) `qniuw9`
- [ ] [An input `gen/*.js` keys a matching file in the gitignored directory `gen`](https://vznjs.github.io/vx/conformance/#dwqfy7) `dwqfy7`
- [ ] [An input naming a generated client under `node_modules` keys it](https://vznjs.github.io/vx/conformance/#qauqbq) `qauqbq`
- [ ] [An input `gen/**` over a gitignored `gen` keys a `node_modules` inside it](https://vznjs.github.io/vx/conformance/#st233k) `st233k`
- [ ] [A brace input `{gen/a.txt,gen/b.txt}` keys each gitignored file it names](https://vznjs.github.io/vx/conformance/#epg8mg) `epg8mg`
- [ ] [A brace input `{gen,out}/**` keys the files of both gitignored directories](https://vznjs.github.io/vx/conformance/#x7ytor) `x7ytor`
- [ ] [An input `gen/**` keys an ignored file beside the `.gitkeep` that keeps `gen` in git](https://vznjs.github.io/vx/conformance/#lavnrz) `lavnrz`
- [ ] [An input `out/**` over an ignored `out` keys an untracked file beside a force-added one](https://vznjs.github.io/vx/conformance/#g99jig) `g99jig`
- [ ] [A task that rewrites its own input runs again once the old bytes are put back](https://vznjs.github.io/vx/conformance/#r7kiu2) `r7kiu2`
- [ ] [An input edited and put back while the task runs does not replay the edited result](https://vznjs.github.io/vx/conformance/#cs3c41) `cs3c41`
- [ ] [An input another task swaps out and puts back while a task reads it is not replayed](https://vznjs.github.io/vx/conformance/#go91gq) `go91gq`
- [ ] [A committed input a dependency edits before the task starts is not replayed once put back](https://vznjs.github.io/vx/conformance/#lrx1a6) `lrx1a6`
- [ ] [An untracked input a dependency edits before the task starts is not replayed once put back](https://vznjs.github.io/vx/conformance/#fcx33u) `fcx33u`
- [ ] [A file behind a linked input directory, edited while the task runs, is not replayed once put back](https://vznjs.github.io/vx/conformance/#h9r9ee) `h9r9ee`
- [ ] [A file behind a linked input file, edited while the task runs, is not replayed once put back](https://vznjs.github.io/vx/conformance/#okzcyr) `okzcyr`
- [ ] [A file the command adds under an input glob is not replayed once it is gone](https://vznjs.github.io/vx/conformance/#se1l3w) `se1l3w`
- [ ] [A file added in a directory created while the task runs is not replayed once it is gone](https://vznjs.github.io/vx/conformance/#zsrajt) `zsrajt`
- [ ] [A named input absent when the task started, then created by it, is not replayed once gone](https://vznjs.github.io/vx/conformance/#vwgxh4) `vwgxh4`
- [ ] [A directory link added under an input glob while the task runs is not replayed once gone](https://vznjs.github.io/vx/conformance/#0ikpbd) `0ikpbd`
- [ ] [Under a git hook’s GIT_INDEX_FILE, a file a nested repository force-added despite its ignore rule is still an input](https://vznjs.github.io/vx/conformance/#4z46q2) `4z46q2`
- [ ] [Under a git hook’s GIT_DIR, a file a nested repository force-added despite its ignore rule is still an input](https://vznjs.github.io/vx/conformance/#2re1k9) `2re1k9`
- [ ] [Under a git hook’s GIT_INDEX_FILE, a file a nested repository force-added despite its ignore rule is still an input](https://vznjs.github.io/vx/conformance/#asbqim) `asbqim`
- [ ] [Under a git hook’s GIT_DIR, a file a nested repository force-added despite its ignore rule is still an input](https://vznjs.github.io/vx/conformance/#miabpp) `miabpp`
- [ ] [An input `src/{b}.txt` never replays a stale result for either file it could name](https://vznjs.github.io/vx/conformance/#mj412t) `mj412t`
- [ ] [A task whose root input is a file its dependency generates sees each fresh version](https://vznjs.github.io/vx/conformance/#sry7cm) `sry7cm`
- [ ] [A task reading a file an uncached task before it writes builds from the bytes written this run](https://vznjs.github.io/vx/conformance/#8bxjh7) `8bxjh7`
- [ ] [A committed file an uncached task rewrites ahead of its reader keys the reader on the new bytes](https://vznjs.github.io/vx/conformance/#bonks5) `bonks5`
- [ ] [A package.json listed as an input and rewritten by an uncached task before its reader keys the reader on the new bytes](https://vznjs.github.io/vx/conformance/#gfwwe1) `gfwwe1`
- [ ] [A root input in a dependency that an uncached task there rewrites keys the dependant on the new bytes](https://vznjs.github.io/vx/conformance/#6tqs4n) `6tqs4n`
- [ ] [An uncached writer reached through a task that does nothing still keys its reader on what it wrote](https://vznjs.github.io/vx/conformance/#fc1lgo) `fc1lgo`
- [ ] [A cached task rewriting a file two do-nothing tasks ahead of its reader keys the reader on the new bytes](https://vznjs.github.io/vx/conformance/#thtsmj) `thtsmj`
- [ ] [A project whose directory is named with glob syntax (`\[lib\]`) still keys its files](https://vznjs.github.io/vx/conformance/#71lfai) `71lfai`
- [ ] [An executable bit still reruns the task when git’s core.fileMode is `false`](https://vznjs.github.io/vx/conformance/#uv49qh) `uv49qh`
- [ ] [An executable bit still reruns the task when git’s core.fileMode is `no`](https://vznjs.github.io/vx/conformance/#tftlwg) `tftlwg`
- [ ] [An executable bit still reruns the task when git’s core.fileMode is `off`](https://vznjs.github.io/vx/conformance/#p6oxrg) `p6oxrg`
- [ ] [An executable bit still reruns the task when git’s core.fileMode is `0`](https://vznjs.github.io/vx/conformance/#1ng82m) `1ng82m`
- [ ] [An executable bit still reruns the task when git’s core.fileMode is empty](https://vznjs.github.io/vx/conformance/#bljuwb) `bljuwb`
- [ ] [An executable bit still reruns the task when git’s core.fileMode is `00`](https://vznjs.github.io/vx/conformance/#fao869) `fao869`
- [ ] [A project’s external dependency changing in the lockfile runs its task again](https://vznjs.github.io/vx/conformance/#9unhoz) `9unhoz`
- [ ] [A change to an external dependency of a workspace package a project links runs that project’s task again](https://vznjs.github.io/vx/conformance/#svvr6j) `svvr6j`
- [ ] [A catalog entry pointed elsewhere runs the task of the project that takes it, and no other](https://vznjs.github.io/vx/conformance/#7q9kd1) `7q9kd1`
- [ ] [Swapping which packages two dependency names install runs the task again](https://vznjs.github.io/vx/conformance/#wpmoqy) `wpmoqy`
- [ ] [Swapping which packages two of the root’s dependency names install runs a task reading them](https://vznjs.github.io/vx/conformance/#f1mo77) `f1mo77`
- [ ] [An edit inside a local directory dependency runs the task of the project depending on it](https://vznjs.github.io/vx/conformance/#whae72) `whae72`
- [ ] [A file added to a local directory dependency runs the task of the project depending on it](https://vznjs.github.io/vx/conformance/#u9uacl) `u9uacl`
- [ ] [An edit to a file a local directory dependency links to runs the task depending on it](https://vznjs.github.io/vx/conformance/#sq0kqi) `sq0kqi`
- [ ] [An edit inside a `link:` directory dependency runs the task of the project depending on it](https://vznjs.github.io/vx/conformance/#d0dwiu) `d0dwiu`
- [ ] [An edit inside a package linked by name (`link:dep`) runs the task depending on it](https://vznjs.github.io/vx/conformance/#xsxk4v) `xsxk4v`
- [ ] [An edit to a local dependency kept inside another project’s directory runs the task of the project depending on it](https://vznjs.github.io/vx/conformance/#czoti0) `czoti0`
- [ ] [A change to the dependencies of a workspace package linked under another name runs the linking project’s task again](https://vznjs.github.io/vx/conformance/#tvkirs) `tvkirs`
- [ ] [A dependency change of a workspace nested in another’s directory runs the nested project’s task again](https://vznjs.github.io/vx/conformance/#yn2y9n) `yn2y9n`
- [ ] [An override that forces a different transitive dependency runs the task of the project reaching it](https://vznjs.github.io/vx/conformance/#a4d2qp) `a4d2qp`
- [ ] [An edit inside a `file:` dependency beside the repository runs the task of the project depending on it](https://vznjs.github.io/vx/conformance/#emjjmn) `emjjmn`
- [ ] [Pointing a `file:` dependency at another directory beside the repository runs the task again](https://vznjs.github.io/vx/conformance/#pgadgj) `pgadgj`
- [ ] [An edit inside a `link:` dependency beside the repository runs the task of the project depending on it, with no install](https://vznjs.github.io/vx/conformance/#96lymw) `96lymw`
- [ ] [A file added to a `link:` dependency beside the repository runs the task of the project depending on it](https://vznjs.github.io/vx/conformance/#hjjhoa) `hjjhoa`
- [ ] [A file added to a `link:` directory dependency runs the task of the project depending on it, with no install](https://vznjs.github.io/vx/conformance/#tkve3q) `tkve3q`
- [ ] [An edit to a `link:` dependency kept inside another project’s directory runs the task of the project depending on it](https://vznjs.github.io/vx/conformance/#gpymj2) `gpymj2`
- [ ] [Pointing a dependency name at another package, the import name unchanged, runs the task again](https://vznjs.github.io/vx/conformance/#emqog5) `emqog5`
- [ ] [An edit behind a dependency installed under another name, linked from beside the repository, runs the task again](https://vznjs.github.io/vx/conformance/#kmlztn) `kmlztn`
- [ ] [A pulled dependency bump run before the install never caches a build of the old package](https://vznjs.github.io/vx/conformance/#16r9pm) `16r9pm`
- [ ] [A pulled bump of a transitive dependency run before the install never caches a build of the old package](https://vznjs.github.io/vx/conformance/#tpezl3) `tpezl3`
- [ ] [Inputs through `@scope`, `a+b` and `(marketing)` directories key the files under them](https://vznjs.github.io/vx/conformance/#lh84n5) `lh84n5`
- [ ] [A key command that leaves a background child running does not hold up the run](https://vznjs.github.io/vx/conformance/#41zq7i) `41zq7i`
- [ ] [A brace input naming `src` and the escaped `app/\\[id\\]` keys both directories](https://vznjs.github.io/vx/conformance/#txs8qj) `txs8qj`
- [ ] [A negation that matches a directory link’s name still keys the files behind it](https://vznjs.github.io/vx/conformance/#prwout) `prwout`
- [ ] [A new version of a workspace package a project depends on runs that project’s pack again](https://vznjs.github.io/vx/conformance/#2vhw6p) `2vhw6p`

### Outputs (66)

- [ ] [A committed edit to a file under the outputs, outside the inputs, is not reverted by a replay](https://vznjs.github.io/vx/conformance/#6oso8o) `6oso8o`
- [ ] [A committed file under the outputs made executable is not made plain again by a replay](https://vznjs.github.io/vx/conformance/#514i24) `514i24`
- [ ] [A file force-added to git under ignored outputs, then edited and committed, is not reverted by a replay](https://vznjs.github.io/vx/conformance/#rivf6e) `rivf6e`
- [ ] [Renaming an input and back leaves only the outputs that name produces](https://vznjs.github.io/vx/conformance/#8tndof) `8tndof`
- [ ] [An output whose name is not UTF-8 is there after the next run, replayed or rebuilt](https://vznjs.github.io/vx/conformance/#zqonea) `zqonea`
- [ ] [A stray file under an output glob the task never wrote to is gone after a replay](https://vznjs.github.io/vx/conformance/#z7mpsz) `z7mpsz`
- [ ] [A stray file under a root output glob the task never wrote to is gone after a replay](https://vznjs.github.io/vx/conformance/#k2eyh9) `k2eyh9`
- [ ] [A committed file reached through a linked output directory is never deleted](https://vznjs.github.io/vx/conformance/#0oddfa) `0oddfa`
- [ ] [An output `**/*.js` never deletes or captures a nested project’s built files](https://vznjs.github.io/vx/conformance/#6gpgii) `6gpgii`
- [ ] [A replayed `app/**` leaves the route `app/\[id\]` a later task adds, and drops a stray beside it](https://vznjs.github.io/vx/conformance/#98scue) `98scue`
- [ ] [A rebuild leaves no output the new inputs no longer produce](https://vznjs.github.io/vx/conformance/#1377q7) `1377q7`
- [ ] [Restoring an older entry leaves no file a later build added](https://vznjs.github.io/vx/conformance/#7uifv5) `7uifv5`
- [ ] [A stray file dropped in an output directory is gone after a restore](https://vznjs.github.io/vx/conformance/#5mh569) `5mh569`
- [ ] [A replayed task that lists no outputs leaves a file it wrote, and the user then edited, alone](https://vznjs.github.io/vx/conformance/#z6c4eo) `z6c4eo`
- [ ] [Empty directories an older build left in the outputs do not come back with a hit](https://vznjs.github.io/vx/conformance/#ae6dtw) `ae6dtw`
- [ ] [A stray empty directory under the outputs is gone after a hit](https://vznjs.github.io/vx/conformance/#7egwxv) `7egwxv`
- [ ] [Output directories come back with the modes the task gave them](https://vznjs.github.io/vx/conformance/#ydnb56) `ydnb56`
- [ ] [Output directory modes come back when the outputs hold a large file too](https://vznjs.github.io/vx/conformance/#45ta8c) `45ta8c`
- [ ] [Restoring into a partly deleted tree gives the directories it remakes their modes](https://vznjs.github.io/vx/conformance/#f1tjx1) `f1tjx1`
- [ ] [An edited output inside a read-only output directory is put back, and the mode kept](https://vznjs.github.io/vx/conformance/#iptgtn) `iptgtn`
- [ ] [A restore writes into an emptied read-only output directory and leaves it read-only](https://vznjs.github.io/vx/conformance/#830ke8) `830ke8`
- [ ] [A stray file added after a hit is gone after the next hit](https://vznjs.github.io/vx/conformance/#owp2pc) `owp2pc`
- [ ] [A brace whose alternative starts with ./ restores both trees](https://vznjs.github.io/vx/conformance/#lfocm2) `lfocm2`
- [ ] [An install task that names node_modules as its output gets it restored](https://vznjs.github.io/vx/conformance/#kqzmyr) `kqzmyr`
- [ ] [A replay where a plain file stands in place of the output directory fails, and keeps the file](https://vznjs.github.io/vx/conformance/#eg7i7t) `eg7i7t`
- [ ] [A task that exits while a child it started still writes its outputs is not replayed with the partial tree](https://vznjs.github.io/vx/conformance/#9lon32) `9lon32`
- [ ] [An output directory that is a symlink is cached through it](https://vznjs.github.io/vx/conformance/#ljp2mw) `ljp2mw`
- [ ] [An output directory that is a symlink is cached through it beside a `**` pattern](https://vznjs.github.io/vx/conformance/#0klq89) `0klq89`
- [ ] [A file pattern under an output directory that is a symlink is cached through it](https://vznjs.github.io/vx/conformance/#dq1t2w) `dq1t2w`
- [ ] [Two unordered tasks declaring the same output pattern: neither loses its file](https://vznjs.github.io/vx/conformance/#myn7ca) `myn7ca`
- [ ] [Two output patterns that both match a file one of the tasks writes: neither loses its file](https://vznjs.github.io/vx/conformance/#ippkcr) `ippkcr`
- [ ] [A task that declares the same tree of the task before it: editing the first keeps the second’s file and none of the first’s old bytes](https://vznjs.github.io/vx/conformance/#9rdiy2) `9rdiy2`
- [ ] [A file a later task deletes from an earlier task’s outputs stays deleted on warm runs](https://vznjs.github.io/vx/conformance/#sfbz8m) `sfbz8m`
- [ ] [One output pattern spelled `./dist/**` and the same pattern spelled `dist/**`: neither loses its file](https://vznjs.github.io/vx/conformance/#5ysnfy) `5ysnfy`
- [ ] [A brace output pattern and a wildcard one that both match the file one task writes: neither loses its file](https://vznjs.github.io/vx/conformance/#fn4p4b) `fn4p4b`
- [ ] [A root output file inside another project’s output tree: neither loses its file](https://vznjs.github.io/vx/conformance/#vc9b1l) `vc9b1l`
- [ ] [A stray in a new directory an anywhere-pattern (`**/dist/**`) reaches is gone after a hit](https://vznjs.github.io/vx/conformance/#uu7jno) `uu7jno`
- [ ] [A stray file in a deleted root output directory is gone when the task replays](https://vznjs.github.io/vx/conformance/#vjxpys) `vjxpys`
- [ ] [Empty directories an older build left in a root output tree do not come back with a hit](https://vznjs.github.io/vx/conformance/#l6a5y2) `l6a5y2`
- [ ] [A stray empty directory under a root output tree is gone after a hit](https://vznjs.github.io/vx/conformance/#p55tj9) `p55tj9`
- [ ] [A hit puts back an edited output, a file replaced by a directory, and removes a stray tree, in one restore](https://vznjs.github.io/vx/conformance/#y8urla) `y8urla`
- [ ] [An output link whose target is not there comes back as the same link](https://vznjs.github.io/vx/conformance/#m39lwx) `m39lwx`
- [ ] [A stray file in an output directory with `!` entries is gone after a replay](https://vznjs.github.io/vx/conformance/#valmkn) `valmkn`
- [ ] [A stray in an earlier task’s outputs is gone after a replay, beside a later task’s narrower `!` entry](https://vznjs.github.io/vx/conformance/#fn4n9b) `fn4n9b`
- [ ] [An output directory the user made a link out of the project stays a link, and a replay writes nothing through it](https://vznjs.github.io/vx/conformance/#srhxw1) `srhxw1`
- [ ] [An output directory the user made a link inside the project is restored through](https://vznjs.github.io/vx/conformance/#sh439w) `sh439w`
- [ ] [A dangling link inside the project at the output directory is restored through: its target made, the link kept](https://vznjs.github.io/vx/conformance/#sr3r4h) `sr3r4h`
- [ ] [A dangling link inside the project below the output directory is restored through: its target made, the link kept](https://vznjs.github.io/vx/conformance/#0z3f08) `0z3f08`
- [ ] [A dangling link inside the project at the output directory, above a deeper output is restored through: its target made, the link kept](https://vznjs.github.io/vx/conformance/#5dyaxh) `5dyaxh`
- [ ] [A dangling link inside the project through a chain of links is restored through: its target made, the link kept](https://vznjs.github.io/vx/conformance/#xcynn2) `xcynn2`
- [ ] [A dangling absolute link inside the project at the output directory is restored through](https://vznjs.github.io/vx/conformance/#q0rubz) `q0rubz`
- [ ] [A dangling output link is restored through by a task that waits on a same-project dependency](https://vznjs.github.io/vx/conformance/#e0n2nc) `e0n2nc`
- [ ] [A dangling output link out of the project at the output directory gets nothing created through it](https://vznjs.github.io/vx/conformance/#ftid8o) `ftid8o`
- [ ] [A dangling output link out of the project below the output directory gets nothing created through it](https://vznjs.github.io/vx/conformance/#pfp5zq) `pfp5zq`
- [ ] [A dangling output link out of the project at the output directory, above a deeper output gets nothing created through it](https://vznjs.github.io/vx/conformance/#qcoxw3) `qcoxw3`
- [ ] [A dangling output link out of the project as the last hop of a chain gets nothing created through it](https://vznjs.github.io/vx/conformance/#irms8g) `irms8g`
- [ ] [A dangling output link out of the project relatively, up out of the project gets nothing created through it](https://vznjs.github.io/vx/conformance/#z771vo) `z771vo`
- [ ] [A stray file in the root project’s output directory is gone after a replay](https://vznjs.github.io/vx/conformance/#17ijxi) `17ijxi`
- [ ] [An output link to a directory, or a dangling one, comes back as the link](https://vznjs.github.io/vx/conformance/#0h7zok) `0h7zok`
- [ ] [Through an output directory that is a link inside the project, a deleted output comes back](https://vznjs.github.io/vx/conformance/#zwlda7) `zwlda7`
- [ ] [Through an output directory link, each build leaves only its own files](https://vznjs.github.io/vx/conformance/#nory2o) `nory2o`
- [ ] [An output list \["dist"\] naming a directory link brings back the file behind the link once it is deleted](https://vznjs.github.io/vx/conformance/#ij1kj3) `ij1kj3`
- [ ] [A rebuild whose output turns from a directory into a file finds no stale directory in its way](https://vznjs.github.io/vx/conformance/#qentt2) `qentt2`
- [ ] [An output named outright, `dist/out`, turns from a directory to a file and back, run and replayed](https://vznjs.github.io/vx/conformance/#7m4ca9) `7m4ca9`
- [ ] [A committed edit under the outputs is not reverted by a replay when the inputs negate the outputs](https://vznjs.github.io/vx/conformance/#v4wsit) `v4wsit`
- [ ] [A task reading the directory an output link points at sees what was written through the link](https://vznjs.github.io/vx/conformance/#cg42yh) `cg42yh`

### Environment (6)

- [ ] [An unset variable and an empty one are different values](https://vznjs.github.io/vx/conformance/#hjbima) `hjbima`
- [ ] [A `.env` file at the workspace root does not set a task’s variable](https://vznjs.github.io/vx/conformance/#imxsel) `imxsel`
- [ ] [Neither `.env.local` nor the `.env.<NODE_ENV>` file sets a task’s variable](https://vznjs.github.io/vx/conformance/#cffxye) `cffxye`
- [ ] [A `.env` in the directory the run starts from does not set a task’s variable](https://vznjs.github.io/vx/conformance/#50esxw) `50esxw`
- [ ] [A project under a directory holding `:` does not run a file the split PATH entry names relative to it](https://vznjs.github.io/vx/conformance/#rqk8s7) `rqk8s7`
- [ ] [An empty arg, spaces, a newline, quotes and `$HOME` each reach the command as one arg, unexpanded](https://vznjs.github.io/vx/conformance/#sy4ut8) `sy4ut8`

### Cache (3)

- [ ] [In a repository with no commit yet the run caches, and the first commit keeps that entry](https://vznjs.github.io/vx/conformance/#05a4xp) `05a4xp`
- [ ] [A server only cached tasks need is not started when they all replay](https://vznjs.github.io/vx/conformance/#s0p48p) `s0p48p`
- [ ] [A forced run after an input edit saves under the new inputs, and the old inputs never replay its result](https://vznjs.github.io/vx/conformance/#o2fkw9) `o2fkw9`

### Run report (4)

- [ ] [A run reports each task’s CPU time](https://vznjs.github.io/vx/conformance/#w21lyl) `w21lyl`
- [ ] [A run reports each task’s peak memory](https://vznjs.github.io/vx/conformance/#z2ywir) `z2ywir`
- [ ] [A run reports the size of what each task wrote](https://vznjs.github.io/vx/conformance/#j90pgm) `j90pgm`
- [ ] [A run reports the size of what a replay restored](https://vznjs.github.io/vx/conformance/#un7oh6) `un7oh6`

### Isolation (1)

- [ ] [A variable the task does not declare never reaches it](https://vznjs.github.io/vx/conformance/#subb09) `subb09`

### Watch mode (9)

- [ ] [An edit made during the watch’s first build is built right after it](https://vznjs.github.io/vx/conformance/#ljrnui) `ljrnui`
- [ ] [An edit made during the watch’s first build, to a task already done, is built right after](https://vznjs.github.io/vx/conformance/#96gq88) `96gq88`
- [ ] [An edit made during the watch’s first build, to a finished task whose project still runs another, is built right after](https://vznjs.github.io/vx/conformance/#6sx40h) `6sx40h`
- [ ] [An edit made during the watch’s first build, in a project whose dev server is already up, is built right after](https://vznjs.github.io/vx/conformance/#oo3eks) `oo3eks`
- [ ] [A source file deleted during the watch’s first build, after its task finished, is built right after](https://vznjs.github.io/vx/conformance/#y9am2r) `y9am2r`
- [ ] [A source file saved and committed during the watch’s first build, after its task finished, is built right after](https://vznjs.github.io/vx/conformance/#4lfcwq) `4lfcwq`
- [ ] [Editing a shared file at the root that the task reads rebuilds it](https://vznjs.github.io/vx/conformance/#iulumo) `iulumo`
- [ ] [Adding a new task to the config while watching does not rebuild the existing one](https://vznjs.github.io/vx/conformance/#l90v4e) `l90v4e`
- [ ] [Editing a file that a source symlink points to rebuilds with the new content](https://vznjs.github.io/vx/conformance/#9uu535) `9uu535`
