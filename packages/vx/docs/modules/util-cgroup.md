# `util/cgroup.ts` — the machine as this process may use it

Inside a container `navigator.hardwareConcurrency` and `os.totalmem()`
report the HOST's cores and RAM; what the kernel enforces is the cgroup
the job runs under — a docker executor's `--cpus` / `--memory`, a
Kubernetes limit. This module reads that. Linux only; elsewhere the
machine's own numbers stand.

## API

```ts
machineParallelism(probe?): number   // cores, capped by the CPU quota, rounded UP, ≥ 1
machineMemoryBytes(probe?): number   // os.totalmem(), capped by the memory limit
cgroupCpuQuota(probe?): number | undefined          // cores as a fraction (1.5 for --cpus=1.5)
cgroupMemoryLimitBytes(probe?): number | undefined  // bytes
```

`probe` (`{ root, procSelfCgroup }`, default `/sys/fs/cgroup` and
`/proc/self/cgroup`) exists for the fixture trees the tests build.

## Rules

- **The walk goes up.** A limit set on an ANCESTOR binds this process
  too, so each reader starts at this process's cgroup (the membership
  file names it), walks to the hierarchy's root and keeps the tightest
  value. v2 is the one unified tree at the root (`memory.max`,
  `cpu.max`); v1 is one mount per controller (`<root>/memory`,
  `<root>/cpu`, with `memory.limit_in_bytes` and `cpu.cfs_quota_us` /
  `cpu.cfs_period_us`), and a controller list like `cpu,cpuacct` still
  names its controller.
- **Unlimited binds nothing.** `max` on v2; on v1 a memory level at the
  page-counter maximum (~2^63, anything past 2^60) and a CPU quota of
  `-1`.
- **A CPU quota rounds UP.** A 1.5-core quota is two workers: the half
  core is real time, and one worker would leave it idle. Never below one.
- **Nothing here throws.** A missing membership file, absent cgroup
  files, an unreadable level, or a membership path that escapes the root
  (a foreign file) all mean "no limit", and the machine's numbers stand.

## Who reads it

`run()`'s default `concurrency`, the placement preview (`placement.ts`)
and `--concurrency <n>%` read `machineParallelism`; both functions are
on the façade so `@vzn/vx-schedule-history` budgets memory by
`machineMemoryBytes` instead of carrying its own walk (items 160–161).

## Tests

`tests/cgroup.test.ts`: fixture trees for both hierarchies — the
tightest level on the path, `max` / the sentinel / `-1`, the fraction,
the combined controller list, absent files, the escape — and one live
read of the machine that must not throw and never exceeds what the OS
reports. This box (2026-09-12) has a v1 memory limit of 13.3 GiB on a
15.7 GiB machine and no CPU quota, so the memory arm is proven live and
the CPU arm by fixture.
