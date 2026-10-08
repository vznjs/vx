# Scheduling counterexample

> SYNTHETIC COUNTEREXAMPLE: real subprocess measurements of waiting tasks, NOT a general performance guarantee.

Status: complete. No favorable-sample filtering; failed runs are fatal.

Analytical case: two commandless readiness gates; 7 DAG nodes, 5 executable tasks.
Both runners receive the same zero-cost readiness gates. This controls when parents become ready: count priority may admit newly ready parents ahead of the independent long task, while a FIFO semaphore may retain the already waiting long task. These are hypotheses about ordering, not guaranteed runner behavior; keep every observed task-start order.
Untraced commandless root gates: f-left-gate, g-right-gate. They have no scripts, output files or task-process traces; their readiness timing is not trace-verified.
Earlier comparator: minimal five-task DAG without readiness gates, source commit d2095b889ef5915a5ba73c964599d3ad7b1ad478; retained separately in packages/vx-bench/counterexample-preliminary-results.json, packages/vx-bench/COUNTEREXAMPLE-PRELIMINARY.md, packages/vx-bench/counterexample-preliminary-samples.jsonl.
The earlier case, including adverse Turborepo runs, stays separate and unchanged. Do not replace, pool, or filter its samples when measuring this different shared DAG.

Analytic ideal: 60000.000 ms; work 120000.000 ms; critical path 60000.000 ms; concurrency 2.
max(work / 2, critical path) = long; the feasible witness attains that lower bound

Witness: both root gates complete at zero duration on worker 0, then worker 0 runs a-long; worker 1 runs b-left → d-left-child → c-right → e-right-child.

- Two identical workers; non-preemptive tasks; exact declared waiting durations.
- Four declared edges: two zero-cost root gates precede their parents, and each parent precedes its child.
- The two commandless gates have no process, script, outputs or trace timestamps. Only executable dependency timing is trace-verified.
- Zero process startup, hashing, cache, I/O and runner overhead in the analytic ideal.
- Measured CLI excess includes all such overhead, timer overshoot and scheduling delay.
- Waiting tasks occupy a worker but are not a CPU-heavy workload.
- Task start timestamps observe process starts, not the internal ready-queue dispatch instant.
- Trace clock: native CLOCK_MONOTONIC via bun:ffi (macOS/libSystem or Linux/glibc), never a per-process or wall-clock origin.
- Turborepo ready order is not assumed to be FIFO; every observed order is retained.

| Runner    | Total median ms | Total min–max ms    | Excess median ms | Excess min–max ms   |
| --------- | --------------: | ------------------- | ---------------: | ------------------- |
| vx        |       89915.841 | 89898.554–89991.763 |        29915.841 | 29898.554–29991.763 |
| Turborepo |       60254.991 | 60233.512–60346.676 |          254.991 | 233.512–346.676     |

Measured TOTAL ratio (vx / Turborepo): 1.492×.
Measured EXCESS ratio ((vx − ideal) / (Turborepo − ideal)): 117.321×.
Excess denominator: 254.991 ms; configured noise floor: 1.000 ms.
Excess ratio envelope over ALL samples: 86.244–128.438× (not a confidence interval).
Ratio status: resolved at configured noise floor and observed spread.
ratio of all-sample medians; no sample filtering; spread envelope is NOT a confidence interval

A large excess ratio is amplification of avoidable overhead/delay, NOT that much faster total execution.

| Round | Position | Runner | Elapsed ms |  CPU ms | Exit | Observed task-start order                                |
| ----: | -------: | ------ | ---------: | ------: | ---: | -------------------------------------------------------- |
|     1 |        1 | vx     |  89915.841 | 413.595 |    0 | c-right → b-left → a-long → e-right-child → d-left-child |
|     1 |        2 | turbo  |  60346.676 | 337.650 |    0 | b-left → a-long → c-right → d-left-child → e-right-child |
|     2 |        1 | turbo  |  60254.991 | 311.728 |    0 | a-long → b-left → c-right → d-left-child → e-right-child |
|     2 |        2 | vx     |  89898.554 | 389.088 |    0 | b-left → c-right → d-left-child → a-long → e-right-child |
|     3 |        1 | vx     |  89909.876 | 384.333 |    0 | b-left → c-right → a-long → e-right-child → d-left-child |
|     3 |        2 | turbo  |  60291.082 | 304.247 |    0 | a-long → c-right → b-left → e-right-child → d-left-child |
|     4 |        1 | turbo  |  60241.916 | 240.567 |    0 | b-left → a-long → c-right → d-left-child → e-right-child |
|     4 |        2 | vx     |  89991.763 | 384.080 |    0 | b-left → c-right → a-long → d-left-child → e-right-child |
|     5 |        1 | vx     |  89946.597 | 469.147 |    0 | b-left → c-right → a-long → d-left-child → e-right-child |
|     5 |        2 | turbo  |  60233.512 | 293.722 |    0 | c-right → a-long → b-left → e-right-child → d-left-child |

All raw JSONL traces, outputs, argv, stdout/stderr, CPU samples, source hashes and preparation logs are in counterexample-results.json.
Elapsed time uses a host monotonic clock around the real CLI subprocess, including startup and exit. CPU uses Bun resourceUsage (microseconds converted to ms): process plus waited-for descendants, not any detached daemon. Daemons and remote caching are disabled.
Each sample has an empty isolated local cache and deleted outputs/trace. No warmup, cache-hit samples, retries or omitted outliers.

## Provenance

```json
{
  "git": {
    "commit": "b82388663a445a9ee099be0f80c81ff66c90c638",
    "branch": "shew/benchmark-scheduling-counterexample",
    "dirtyStatus": "M README.md\n M packages/vx-bench/update-site.ts\n M packages/vx-bench/vx.config.ts\n M packages/vx-docs/src/pages/index.astro\n M packages/vx-docs/tests/landing.test.ts\n M packages/vx/docs/STATUS.md\n M packages/vx/docs/benchmarks.md\n?? packages/vx-bench/COUNTEREXAMPLE-PRELIMINARY.md\n?? packages/vx-bench/COUNTEREXAMPLE.md\n?? packages/vx-bench/counterexample-preliminary-results.json\n?? packages/vx-bench/counterexample-preliminary-samples.jsonl\n?? packages/vx-bench/counterexample-results.json\n?? packages/vx-bench/tests/update-site.test.ts"
  },
  "harness": {
    "path": "/Users/anthonyshew/projects/open/vx/packages/vx-bench/counterexample.ts",
    "sha256": "2f1202489ff6d8046ba2c05732c27f859bc4603b23b0f2912c12edcf36ebe037"
  },
  "coreSource": {
    "files": {
      "bun.lock": "b1dda48bf7f98569a7619ac6ff7648240030a003fa95ae6068a1b1a573fb56e7",
      "packages/vx/package.json": "94aec7dc6e676aebdd3d3b6bba7b8cd8ca1f371f4ac83b07410f253e3c27ed88",
      "packages/vx/src/bin.ts": "a27dc54b23f0a9f2d53209639d8a3ebbd07db16cfd6adb4b162ab880eb13097e",
      "packages/vx/src/cache/archive.ts": "e1da0f0589b606b7055323ffdb6fc2b5d19a0f489240832ded87fc1501cead38",
      "packages/vx/src/cache/cache.ts": "47eb291b9708a73d97272420e353a31fab87f927faceb75edda0df86402977d7",
      "packages/vx/src/cache/chained-cache.ts": "865a086a9c5e845e827de03f03d13605d5b90053dda682d2e87bba99b010d597",
      "packages/vx/src/cache/config-evals.ts": "00ab3b91178d5c2a7c940589d316a8c70678b2c6fd92abfc6ae3e88ab3e0c8cd",
      "packages/vx/src/cache/file-hashes.ts": "fbe237d1cc00a7506a3339aeea20b411935cd622f812714ed728129a9847c6d2",
      "packages/vx/src/cache/git-inputs.ts": "0a8cf2527bb0d77e56444cc7b1112d0d6140f7ed3b77cfa2a7e3debba3407eed",
      "packages/vx/src/cache/index.ts": "2e6c3c830deba03fc9d44f86cf460a9dfcf4c9a584fe9097964482c7315ba0ea",
      "packages/vx/src/cache/inputs.ts": "f63dcb68a454feed8da1d0a62c624b991f9e3bc552bfffc0ab0c7d605cd006e7",
      "packages/vx/src/cache/key-fold.ts": "3ad903ef24ee5f6d3ee0203af3c6cfdf449afccacb04a4e7f508fcb679511560",
      "packages/vx/src/cache/layer.ts": "f4cdb4d2abe5d19977ffcfece54e0d01057b6023fb8e520cbf40fded436669d6",
      "packages/vx/src/cache/layered-cache.ts": "ec77fc1dd84a18e1ce41b98e7d5646591860d4623e50f3f014da4a64c0733e84",
      "packages/vx/src/cache/output-index.ts": "90446a3b3c74212013a5ab9a37c3f05872aec73201a2a90ce429b2715efbdaf9",
      "packages/vx/src/cache/policy.ts": "5ed7277e3452a1d9713cfb16760685f1b5a2daa64e74396411330ec5fff1b90c",
      "packages/vx/src/cache/run-history.ts": "ae2476115d76674948707e9a4e585bcfe4d6cf22c6edbf0a76895cd06b4cd604",
      "packages/vx/src/cache/schema.ts": "ed552e3917b9f0b52238c689f743e58ab650b33ea44ece9aa145d3db94127c9c",
      "packages/vx/src/cache/tar-stream.ts": "599dac16341c55f37372c5ebdccbad1956fad2b205511c63d391237a995b5dc7",
      "packages/vx/src/cache/zstd.ts": "9f0cbd17a63e0e7bf333cb4a18983311326902499f4f49cdba522b20c592d801",
      "packages/vx/src/cli/cache.ts": "1be4bc6deaa5eb7218ba25fb16b211b4d36d92dd3b919cdc8bca3374ce6d02cf",
      "packages/vx/src/cli/completions.ts": "99b7d4af4a644e1d414eb2d9387606537b63227523075c6845fb2b944fc5b748",
      "packages/vx/src/cli/core-alias.ts": "1a0f2cefa6c2c4b69b49c9c67d1571ea816fc504b4ca2c88d32fdf1ff43ae99f",
      "packages/vx/src/cli/foreign-flags.ts": "b1a931e7e815b92032fe7e3e204e0bd697bd74f765a9ba5da929a8ebd0e96347",
      "packages/vx/src/cli/format.ts": "b1fd829104f7c0eb5f1581fa22a27fbd94f31f6e94af41ede6c1662215b21242",
      "packages/vx/src/cli/help.ts": "1172a8c9189060de8e8b1cfc4f09458bac98c30b8f8df60f391a56b97825cdd3",
      "packages/vx/src/cli/index.ts": "ab08d498263c18de170bad842090b5bf84fa161153b0e9404fb11dcd6bc4519e",
      "packages/vx/src/cli/info.ts": "a555473636c96c40f7c71e6ef11034a2e2964a1978ef86380c3c206f5665d1b6",
      "packages/vx/src/cli/init.ts": "ae3252342122601004cc9766665ea2d61d3b9652803cbe7350af23c4a4fae1ed",
      "packages/vx/src/cli/last.ts": "0c26df590528e0651ebe276a43712f45bd6abf826b8695021e1e36eb46138faa",
      "packages/vx/src/cli/lock.ts": "af91504dadbe427a28587da21caf2b951e759b0830c376feb7050bf0f7ca8895",
      "packages/vx/src/cli/plan-format.ts": "fa817cc7a227348e3d5a79e66d04c1b6032c8a89869f3abdbeeca927e818159f",
      "packages/vx/src/cli/plugin-commands.ts": "8fbef02383bab322ce13be7c9112c2773ea79f721f68edd8f6f8498400dad258",
      "packages/vx/src/cli/plugin-templates.ts": "aa05914c06614d173f82ca5f9ce38f0992d6d1bcb11d49029bc2629898bbf6c0",
      "packages/vx/src/cli/run.ts": "cc53bd13b9d34917123301e42ecba9a5a213090bf28d5e3bc197e452a95394f5",
      "packages/vx/src/cli/select.ts": "fd2989c223fb0ab79225a1288c519078aaa8a702acb9a5adb0140742c9a92ad0",
      "packages/vx/src/cli/show.ts": "2d9a7d76b4b87d3296574a88640af1dffa43eeae5b9b50d176e7b7ed2bdefe82",
      "packages/vx/src/cli/task-verb.ts": "3de25acbcb3cd715d6cac3c57be1b9ae355e86abd70be972761fb7c5f46fa257",
      "packages/vx/src/cli/upgrade.ts": "9af8b4c732ea2dddc29b5eb28a6d74b27b6370fe06fd392346f56171f9708d37",
      "packages/vx/src/cli/watch-cycle.ts": "e8fc2d4e3d3cbde83411d1f1352fb9da77418fbd0df3d860a1688aca69d5b228",
      "packages/vx/src/cli/watch-filter.ts": "028a70f59f5d7bdb7b4ca1bddd0dbcabf4c991c9b64c660fe73f93236bbd06bb",
      "packages/vx/src/cli/watch-fs.ts": "a1f14a9bd3f1528c565da1142ceeec5d2c1906e55ed6bf6cb92af8bd6c4a75fe",
      "packages/vx/src/cli/watch-judge.ts": "3e5a7cf129517d76222f81297ade06831ae008f3edec86dff9eaf3a44efef328",
      "packages/vx/src/cli/watch-set.ts": "bd060ebf7befd5a8d79a46c7b4b866af5d4f492f88fd5711190a75b491675ce5",
      "packages/vx/src/cli/watch.ts": "1f576de0f0b1c3778ab10b0927e14b5d69c4dcaf8325fccdae1079e6121a6a84",
      "packages/vx/src/cli/why.ts": "5d58b287232719011eba6a7279c4a5f140ddad85aef60eeccefc04f2242d39a0",
      "packages/vx/src/cli/workspace-config.ts": "359f8caafd2bab2145aecca2a98c21c20c27bdd2c8515a9f41aaeee0e6608ef6",
      "packages/vx/src/config.ts": "a0976971dccb0737f6eb2da7c786f4a5cd9d8f2dfa7dc70cca852d5a990fdff4",
      "packages/vx/src/exec/env.ts": "32ffba07ad983db244b5d4ab8f60c7a10afc9d5a40ee6ce8eb65a96cecacb049",
      "packages/vx/src/exec/executor.ts": "fc5b983b4edc719b3e2e64189a425e46567bbfd986fbc17051f4231c9ae31048",
      "packages/vx/src/exec/index.ts": "b70dab9aa2cad0abd1e55a05ac3deabb874f1cd172b70e722842d157b14ed83c",
      "packages/vx/src/exec/kill-tree.ts": "0d9511339261c8d340ade69eec495b243e6371153f2aa4c8b8f377fbe8231eca",
      "packages/vx/src/exec/local-executor.ts": "52dc7b8f120768a61e86fcbe5d63d68a41af1c07c7a411a360a7747e1aacd491",
      "packages/vx/src/exec/proc-sample.ts": "1a84673ddfa428edfbd5bc7fb05e133f820609d49a3837ec911eb2ddc038e59a",
      "packages/vx/src/exec/runner.ts": "10f6b4e0411d4492a75d59be71dc3ff8c0cd5527e78cd5a705f3862472d1d03f",
      "packages/vx/src/exec/sandbox-binds.ts": "96ab159422cb027653332fc9d354d70080066df4d889c03baa7eb12deab757aa",
      "packages/vx/src/exec/sandbox-deny-scan.ts": "519d8be9bdc6cb2320fd952e671ae91dcc146417295a635e1121e373ece45511",
      "packages/vx/src/exec/sandbox-paths.ts": "011be690dca7210382831a70fac1d42674c8231f148b00f2852c518f71aa8f99",
      "packages/vx/src/exec/sandbox-runtime.ts": "5ddbd6c45cd77e41f7fdd307bc8a37cde877a6ddd4194c6f01e00adc0f7b0d6f",
      "packages/vx/src/exec/sandbox-violations.ts": "eb1bee2b493b28ef232a9e443701fb76c2eafded53d894b2d8616d061d93e370",
      "packages/vx/src/graph/dependency-spec.ts": "56125c52e49e72837b26cf8ec49fa6421060331e0e7d48fbb58fd41c95af0895",
      "packages/vx/src/graph/index.ts": "347a005c705676397fbf44b7260b15fccea705dcc6e4ebebeb10fe8a79d55c16",
      "packages/vx/src/graph/priorities.ts": "253789f0cadc4f8636d6f89237ebb79805c4ba615fbee5768fc59e156aa40cec",
      "packages/vx/src/graph/scheduler.ts": "9a823e1213892c6b93f2ad426f8b79ee0ef156068113eddd5853e1193a0eeb73",
      "packages/vx/src/graph/task-graph.ts": "503fa8c0026d3324bfde8cc6eafba76509d8e751bfe4b0c458b4aeeb92a96eef",
      "packages/vx/src/index.ts": "2718aef98f8b466e02ce7c5c2da7c917eb5597476d55a8a495bbf35903cbc42a",
      "packages/vx/src/orchestrator/admission.ts": "751683e3993f1263b8d2ed6fce975b4e32454f6335af0306b457b3f6509fced5",
      "packages/vx/src/orchestrator/affected-tasks.ts": "8cdce3313d75863d79955aa65543732a92b3152dbac37a2c0dc90055f673b3e4",
      "packages/vx/src/orchestrator/colors.ts": "b205e752eb93d0b747d106c28f1dfd5fda6a9693f0b478e7071599bd8c9fff12",
      "packages/vx/src/orchestrator/deferred-outputs.ts": "46b160edbc0def0bfbada58e0ca9e45d8aba3d2aa20027da1ce38e9e6ade3008",
      "packages/vx/src/orchestrator/doctor.ts": "1792ac52d1edf52a0ba84c4e52513d9808bdd3e934bf6786f5431073be5faa5b",
      "packages/vx/src/orchestrator/download-policy.ts": "50593e05ac7d9c5916cea20a5e660ef71c7f83763ecbddc94e8a06994fdbb5e7",
      "packages/vx/src/orchestrator/events.ts": "ab683cdf27158133db103f5afd3ca24963229e4d4a5e8792520b28cc8c4752b4",
      "packages/vx/src/orchestrator/excluded-keys.ts": "e552888ad583209fa7aabb95f961ab5159f3421cf8b8779a99f6f31cd8aaf22e",
      "packages/vx/src/orchestrator/execute-task.ts": "9d30c62436c547c0e8aba24ba3e9a49caa84f8feb6650817daaf9f6a07b02cbe",
      "packages/vx/src/orchestrator/failure-mode.ts": "9740d82550b6f60f828fb2bf2d0370f218f7b33fffe4034a3e6af3f409592f42",
      "packages/vx/src/orchestrator/fingerprint-watch.ts": "1120c7fa5f988f12a95dc5621e1ff804de01f5a74c06392486a637e4523bdd0e",
      "packages/vx/src/orchestrator/forecast.ts": "93c4f8cb1743ba1fe1fa348adc84d354660da4fdf72b6e320b646f884d04b194",
      "packages/vx/src/orchestrator/framed-output.ts": "87af8c0db78f8ad0821446baa27789bf28efdde11cc722df19843516cc2d9013",
      "packages/vx/src/orchestrator/graph-stage.ts": "3fedccd88108f78bab5c7506d8310334673fad5390f2b6a66e4bcfc6ee41d2a3",
      "packages/vx/src/orchestrator/history.ts": "605c15e47319f9b9b4f75549f2313c13c45d027e06db2ff622854c8de648ca5f",
      "packages/vx/src/orchestrator/hit-restore.ts": "f15c076169579d5c8884ace7a78b06dd79b22d8eec9e805b9d764df942965d6a",
      "packages/vx/src/orchestrator/index.ts": "ec1b0863e3827671d843755a50b8dbee1f26143da62654a0a499e5bbb4038c4e",
      "packages/vx/src/orchestrator/keyed-projects.ts": "5d13b843e32bdbcbcf12590d8e196a699ca84bdf1d2f19ab9ce7aa1bbaf45433",
      "packages/vx/src/orchestrator/local-shortcircuit.ts": "47b16a8b89aa332794c1c22d9c2f52de64f326e0c210b32a499d35ba1e2ef39e",
      "packages/vx/src/orchestrator/lockfile-claim.ts": "5dddc450f72765123b93f3e83e3052c320b27e08929d1010f0cc9f9f0a513648",
      "packages/vx/src/orchestrator/logger.ts": "e67638eb2ea9a551135f4ba5ba2c1f6c84309261dbe4e54da65f2c9e53225d4e",
      "packages/vx/src/orchestrator/metrics.ts": "de59b7c213951a8e7c822f348a4770c0660e9509ba328add0e6db7c3271ffe82",
      "packages/vx/src/orchestrator/miss-reason.ts": "3f4edf4abf2f0af001558d2f941fe59a65306ff5a6657c19413973f7e9096bce",
      "packages/vx/src/orchestrator/miss-save.ts": "2e17c3bf12af495dc3b390a817ca7457391a9ede9c0738c799c7110b477aa554",
      "packages/vx/src/orchestrator/options.ts": "45af4f71a0a01a58b3f7b9758c90bfdd19dd5c514087fc0e5723e017cf6a8bae",
      "packages/vx/src/orchestrator/output-log.ts": "93522ad24b8dfbea6c4783f57d5c14d6a78d43a948bb8ee4a2abe8c89b4aa3f5",
      "packages/vx/src/orchestrator/persistent.ts": "dc7d0563e04a365f1f858c30084060693177c1addbe79d9f88c59ad1e61115e0",
      "packages/vx/src/orchestrator/placement.ts": "207c45fc2313fe914e64ba936f1223255c316b37c7ce7387a4c0697e54d3f76c",
      "packages/vx/src/orchestrator/plain-output.ts": "a1ceec791758eb96cddefe8a85d15f278d0e7445ccac489aa3ce5de4f0a6968c",
      "packages/vx/src/orchestrator/plan.ts": "8046dde4af5308d60abef71edd5e087820df2d28a9de886d4eafba1bb74462e3",
      "packages/vx/src/orchestrator/plugin-host.ts": "f9a93f24087b257b4eae080a539f41f242264d3cf98b21806fd192d341757d8e",
      "packages/vx/src/orchestrator/plugin.ts": "4d30f17372feee57bde28dbb51ab47ff4442c0468a7914447ae7e55c761c1bc3",
      "packages/vx/src/orchestrator/prepare.ts": "2966f745811eed7a1fbff7c85f3a7b60508c6367e9bc1bbd6790271b92ed6afb",
      "packages/vx/src/orchestrator/projects.ts": "a484aac42870ea99c5a4d8cf6531d7b3c0e8c5f6c117687992293a2c4b776fc5",
      "packages/vx/src/orchestrator/remote-prefetch.ts": "926209256fc7471eddefa7a3094e17683f7cc1703cfe0a08ca761e5e2161e4cc",
      "packages/vx/src/orchestrator/run-artifacts.ts": "4a89655496d5e06d89fa1f8d6c416446fe75ae8c8c451b7c780255579c1a6ab6",
      "packages/vx/src/orchestrator/run-context.ts": "0fc54351cddd71774057fc4f9695f0e9b872ae4682024aa5950c64d9a4405b29",
      "packages/vx/src/orchestrator/run-id.ts": "7afd27cfcec22cf1d2216f268959b891de217624ad58353db9bc13cd9307992b",
      "packages/vx/src/orchestrator/run-lock.ts": "63bf8fd2c8c1cbf3746caf1cdf1bc8a212f8340547a2b4e9cfd22044ec469231",
      "packages/vx/src/orchestrator/run-records.ts": "50e319786f4060f34931b2554afd08c6f4f03ff28605fddfceaa9b1353d66ef8",
      "packages/vx/src/orchestrator/run-report.ts": "d7910a9e34601bdc24092a67836847d07ba802c01e57cf6bb05733d1db09e679",
      "packages/vx/src/orchestrator/run.ts": "bc3112f7bea46501fd97e8a4745a3dcad92edd9f45306190497b88742ca94012",
      "packages/vx/src/orchestrator/sandbox-request.ts": "50bd8299a7d504ee3dfe6959d8b0f029325f9e63b733a83ebc16742c093a5779",
      "packages/vx/src/orchestrator/save-lane.ts": "e212225f057d38d79e49071bcdb52b49d6932ae290133ec1799e46ec59eb419e",
      "packages/vx/src/orchestrator/shell-verdict.ts": "043fe1181514202cc4449c60627361f27ede48745d5f33c286de448c2ab01f3f",
      "packages/vx/src/orchestrator/signals.ts": "632b62f14eeb0ec05df1e958bc2c646acd17af5c7d9a8aa9a955d69767621e47",
      "packages/vx/src/orchestrator/stable-keys.ts": "4c07f928d55f6cd5b13358547a556e0b495bc824c15a13f6ac7ded2dd3357c8a",
      "packages/vx/src/orchestrator/status-line.ts": "a00b030b82bbda421a170752f1ad76a0345ada4de20d970b73e858de037921ac",
      "packages/vx/src/orchestrator/summary.ts": "d79502c93751d9445c6f64239b0696492730211bb1f870b4bc98f857d5d83cc9",
      "packages/vx/src/orchestrator/tally.ts": "1881b26deed80838508399fced6a3aec416256fa9270ac9dab6c21d8628e9422",
      "packages/vx/src/orchestrator/task-hash.ts": "87d8ec1eff3ce0aac99df7d53414066a876df15d437561174e4013c62f00b3b5",
      "packages/vx/src/orchestrator/task-log-buffer.ts": "1dcce1b23742aba73471d58e3aac1f40a40ae22030e23f5f494f5f1ae0337101",
      "packages/vx/src/orchestrator/telemetry-host.ts": "01d43f4dca3ce9679a3e6e2be696d00c229356b9e3e650397b5a9d229f316bbe",
      "packages/vx/src/orchestrator/telemetry.ts": "30d6955c8265de70e48e269635a2c907b159b42212d77947b669b3d59799ba13",
      "packages/vx/src/orchestrator/terminal-signals.ts": "437fdab4ee87511018dcda9abde846c66a067a2628f7b164a1bcbf44b59f4857",
      "packages/vx/src/orchestrator/upstream.ts": "51f70b4a737ff3ebef9ef9b8d2bba67feacef87f9a1018ac09c749e62b391ec1",
      "packages/vx/src/util/bun-version.ts": "3580d8447d2d7708389a02b3642ccc80412e20e5ac82b8470d163d87c817578f",
      "packages/vx/src/util/cgroup.ts": "b1301529deffba0086f16a2fb137d9ed76b9b8ae88c0bf241ad04735093886f0",
      "packages/vx/src/util/config-frame.ts": "8e534a20caf310da4c403ad3740fef5b062481dc5c5f16922eb89f6e95822b3d",
      "packages/vx/src/util/edit-distance.ts": "e2eaf725015c37bf910ab716d82b243f5bc392ce7a12620debae7911a264b232",
      "packages/vx/src/util/errors.ts": "465885121270f99a55fb51f15d9155df06c913288a32f4b55683db0d903d0417",
      "packages/vx/src/util/hangup.ts": "eb2fcca51e271a3924cd54ea204469e2e9bcf21a53e6f4e5eae7ba88d870eef5",
      "packages/vx/src/util/hash.ts": "b31dff6507058c3a359929a0151a168e27a0be174fc8bc8491d1924cbae2c9a3",
      "packages/vx/src/util/index.ts": "9e9b123639afd629bfe05f73671c20da40f6794f76de6510d08d5e73a4ff4f5b",
      "packages/vx/src/util/num.ts": "f2668268a40de9e57788f44c49023c28e46d12c6c50f165827f55157d6299820",
      "packages/vx/src/util/paths.ts": "26fb912f483fa200ae48e999d4d8760af7bd6d34972e859013c4d3458cb52fc2",
      "packages/vx/src/util/procfs.ts": "c103d4d8a6d057283ec9bd90e8ca269f9f684c61e407d42be560c493c2923f02",
      "packages/vx/src/util/real-path.ts": "0b2bcc9bf5b4bbd296628f32ba6f4e969612055dd5eb0143e0b3f8dec22cc801",
      "packages/vx/src/util/secret-mask.ts": "b527d4ef4631e44f5a3f2ba1d1bdc24f7303b2577bb8da0a675ecaf2db55313a",
      "packages/vx/src/util/settle.ts": "fe02827903614b8b8fa02dabd9ec73f5758818ec4ce25e9b9b199c5a6c5f1dfa",
      "packages/vx/src/util/size.ts": "0eb77542f90db458bb82e22b8be2e6d231f8da3dc0091f85b6c55afa6046a581",
      "packages/vx/src/util/tail.ts": "62ddcc4389008d30e896e402335f8a3dcdac38de249d52d8501b8d0ce48ca3d2",
      "packages/vx/src/util/task-id.ts": "a9db0052e1f8d6d7d08fd6b0b6096b23bf9e08d986b62f0c28388d45f7b58906",
      "packages/vx/src/util/timing.ts": "df4e7242453d820f069e0f5651272fb9c8bd45ea217b0a19b3dae7386381d156",
      "packages/vx/src/util/ulid.ts": "424abbbe62b2e7750c9f9bed8db6b177104335d42a25b52f5da2ef45e287618c",
      "packages/vx/src/util/verbs.ts": "6d1df689a9288fec1a64138494990c7ba4564dd347744a7ee8ec39e5e230cb4c",
      "packages/vx/src/util/which.ts": "5ad846a3d7b05d451ce4c2b6950db5cbd7b7327901214a676ce97b2c7c561929",
      "packages/vx/src/version.ts": "4c1dcbc425e45d45493175681d46bcc27a64d546c5be5685746080580874bf45",
      "packages/vx/src/workspace/affected.ts": "bb1c372b8f1ef054ba1d53fdd24f3cf12ad53e6473a78cd89f22705a9ef9e10d",
      "packages/vx/src/workspace/config-cache.ts": "089b5f0eb530c7510c55ff3579b562e860674cf6ca1ca9224209cf48a052593a",
      "packages/vx/src/workspace/config-eval.ts": "f0e33c3e826d3fee998683a005a0a069c2d842d23327eb64688692e15479ee04",
      "packages/vx/src/workspace/config-imports.ts": "86bc5a08c5e059aa515efab0e7d180c6a98eabfc459ed34c2d4e3224e011039c",
      "packages/vx/src/workspace/config-schema.ts": "ce9a6e78def2b7b26d6ede928ba6f5356ae6f64e9b70c9e35cb2775ebe90873e",
      "packages/vx/src/workspace/filter.ts": "9540d61bdc61ec01eca32855ae90e0b84dddd753fa6b937083396a8acb45fe5c",
      "packages/vx/src/workspace/fingerprint.ts": "b6dc84b07ac2bb372f8e5693af157eebd55d15b5966e5a2a079024e7851cfe1c",
      "packages/vx/src/workspace/index.ts": "c60c64988cc4a9bfe0a71fea94937ba7f25bed3a7e2a84927d3ec8494f207e37",
      "packages/vx/src/workspace/json-data.ts": "a331c581165392327a9023a03ab642d1478e5c15caf29e10fcb36015c8f6487a",
      "packages/vx/src/workspace/load-reads.ts": "5567085242300a41d32e7476411a0f15ce2c226fd73c4e1f85fc9a2b8ffb538c",
      "packages/vx/src/workspace/lockfile.ts": "e28b1436e2b83f43613f9f9b9377e703e230c791a857983fe4055de4dabb02f4",
      "packages/vx/src/workspace/migrate-scripts.ts": "cbe493e220ad101156f2bf38e628cbdde2eb7999fae4f6cbbe22bb4f828aa8de",
      "packages/vx/src/workspace/migration.ts": "b27662f96865000417bda76badd557c4c6a6b2a41ee0416bdc2af60e2aaadbec",
      "packages/vx/src/workspace/nested-dirs.ts": "ee52948a4256770f106aecfb8ea158abaea4be7e27d589e1f4b691328c34d00c",
      "packages/vx/src/workspace/package-graph.ts": "fb78963ec8c28fd97742d90e3b705676eb9dc05bb6847db76821446399aec4ba",
      "packages/vx/src/workspace/project-loader.ts": "3fb9077ca543630e373210e465006a322248be44f42311e3161956ea7b395e70",
      "packages/vx/src/workspace/repo-id.ts": "a0e03df2609ba0655e2faad871f3d66cb786c00e6ed90206d666992b435b589a",
      "packages/vx/src/workspace/workspace.ts": "81450a1ee8cded84ba83f8428f5109997bf8b86f990bdfcc56b91b7bae86185b"
    },
    "sha256": "e29ff40b5b6c2de56c962808c9a9149c7895b093e52cbd8954a0d6d93a4e885d"
  },
  "bun": {
    "version": "1.4.2",
    "revision": "1.4.2+744846f84",
    "executable": "/private/tmp/vx-benchmark-inspect.HXscnx/toolchain/package/bin/bun",
    "sha256": "35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5"
  },
  "gitVersion": "git version 2.50.1",
  "host": {
    "platform": "darwin",
    "arch": "arm64",
    "release": "25.6.0",
    "cores": 14,
    "availableParallelism": 14,
    "cpuModels": ["Apple M4 Max"],
    "totalMemoryBytes": 38654705664
  },
  "harnessArgv": [
    "/private/tmp/vx-benchmark-inspect.HXscnx/toolchain/package/bin/bun",
    "/Users/anthonyshew/projects/open/vx/packages/vx-bench/counterexample.ts",
    "--long",
    "60",
    "--leaf",
    "0.25",
    "--reps",
    "5"
  ],
  "environmentPolicy": "allowlist: isolated HOME/XDG; PATH prefixed with exact Bun; no inherited TURBO_*, VX_*, BUN_*, NODE_OPTIONS, NODE_PATH or credentials; no dotenv; local caches only",
  "preparationTimedAsSamples": false,
  "orderPolicy": "odd rounds vx then turbo; even rounds turbo then vx; keep every attempted sample, abort on failure",
  "cpuUnits": "Bun cpuTime user/system are microseconds, divided by 1000; process plus waited-for descendants",
  "tools": {
    "vx": {
      "path": "/private/var/folders/0r/90dc16493lx7gw025k4z8sw40000gn/T/vx-counterexample-LT04Xf/bin/vx",
      "version": "vx 0.0.0",
      "sha256": "f7b29408a35ee0eea82cd052ecbdfd0a2ed7569c72f3c5ca9a48adb6c8d0e462",
      "sourceCommit": "b82388663a445a9ee099be0f80c81ff66c90c638",
      "origin": "compiled from clean core source at recorded commit; minify + bytecode; ad-hoc signed on macOS"
    },
    "turbo": {
      "path": "/private/var/folders/0r/90dc16493lx7gw025k4z8sw40000gn/T/vx-counterexample-LT04Xf/fixture/node_modules/.bun/@turbo+darwin-arm64@2.11.7/node_modules/@turbo/darwin-arm64/bin/turbo",
      "version": "2.11.7",
      "sha256": "b10e28233aabac29e5e8f6c95f438b3407fc1cd5706305b0e215aa17602aa9ce",
      "headerFormat": "Mach-O",
      "executionMode": "native-direct",
      "nativePackage": {
        "name": "@turbo/darwin-arm64",
        "version": "2.11.7",
        "description": "The darwin-arm64 binary for turbo, a monorepo build system.",
        "repository": "https://github.com/vercel/turborepo",
        "bugs": "https://github.com/vercel/turborepo/issues",
        "homepage": "https://turborepo.dev",
        "license": "MIT",
        "os": ["darwin"],
        "cpu": ["arm64"],
        "preferUnplugged": true,
        "publishConfig": {
          "access": "public"
        },
        "packageJson": "/private/var/folders/0r/90dc16493lx7gw025k4z8sw40000gn/T/vx-counterexample-LT04Xf/fixture/node_modules/.bun/@turbo+darwin-arm64@2.11.7/node_modules/@turbo/darwin-arm64/package.json",
        "sha256": "ed5d726d0bba99cca6edc1c81119ea121d214da5b5ffb0c4e6479485300fc5b3"
      },
      "origin": "native direct run of pinned installed platform optional dependency; Node launcher bypassed"
    }
  },
  "traceClock": {
    "method": "native clock_gettime(CLOCK_MONOTONIC) via bun:ffi",
    "units": "nanoseconds as decimal strings; timespec int64 seconds + int64 nanoseconds",
    "probes": [
      {
        "monotonicNs": "211417915915000",
        "processRelativeNs": "4688584",
        "pid": 36031
      },
      {
        "monotonicNs": "211417924949000",
        "processRelativeNs": "4081584",
        "pid": 36032
      }
    ]
  }
}
```
