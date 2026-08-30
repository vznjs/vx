# Agent pool: Nomad as the cluster backend, Kubernetes dropped (2026-08)

> **Status:** accepted (2026-08-30). Records why `@vzn/vx-agents` keeps
> `docker` (local, zero setup) and `nomad` (cluster) and removes the
> `kubernetes` backend added in `68660ed`. The removed code is in git
> history; §7 is the specification a returning backend must satisfy.

## 1. What we're solving

`@vzn/vx-agents` is an `executor` plugin that keeps warm agents and
`exec`s a task's command into one, instead of shipping a hermetic input
tree per action the way `@vzn/vx-reapi` does. That choice is measured:
REAPI put a ~7 s floor under every task here because `node_modules` is
26 084 files each action had to materialise, and the same commands on a
warm agent run in 175–517 ms. Container start is ~400 ms against ~30 ms
to exec into something already running, so the agent must outlive the
task.

The pool is demand-driven: `acquire(key, spec)` creates an agent only
when a task needs one and none of that size is free, core calls
`TaskExecutor.demand(remaining)` after placement and after every
completion, and `shed()` disposes idle agents the remaining work cannot
use. So the backend contract is four verbs — **create one agent of a
given size, exec into it repeatedly, destroy exactly that one, on
request** — and everything below is judged against them.

Evidence: the timings and the docker transport are measured here; the
Nomad backend's spec builders are unit-tested (`tests/backends.test.ts`)
and its runtime shape is reasoned from the Nomad API; the Kubernetes
backend was never run against a live cluster — only `podManifest()` was
pinned — so every claim about its runtime behaviour below is reasoned.

## 2. The unit mismatch

Both schedulers' natural primitive is "run this to completion": a Nomad
`batch` job, a Kubernetes `Job`. Neither is a warm agent, so each
backend bends its scheduler.

Nomad bends least, because `Type: 'service'` is a first-class job type
meaning _keep this running_, which is what an agent is. We submit a
`service` job with one `TaskGroup`, `Count: 1`, a docker-driver task
whose `entrypoint` is overridden to `['sh']` with
`args: ['-c','sleep infinity']`, `work_dir` at the container workspace
and `volumes: ['<host>:<container>']`. The only subversion is in the
policies — `RestartPolicy: { Attempts: 0, Mode: 'fail' }` and
`ReschedulePolicy: { Attempts: 0, Unlimited: false }`. Nomad's default
is to bring a service back; we do not want that, because a resurrected
allocation has a new id, so the pool would hold a lease on something
gone while Nomad quietly ran a replacement nobody execs into. Restarts
off makes a dead agent _stay_ dead, which the pool observes as a failed
exec.

Kubernetes has no `service`-shaped equivalent for one process. The
removed backend used a **bare Pod**: `restartPolicy: 'Never'`,
`command: ['sh','-c','sleep infinity']`,
`terminationGracePeriodSeconds: 0`, `requests`/`limits` on the single
container — deliberately not a `Job`, because a Job that never completes
is a Job whose status lies for the run's duration, whose `backoffLimit`
and `completions` say nothing about an agent, and whose Pod name is
generated so the exec target needs an extra lookup. The bare Pod is
honest about what it is, but it is also the shape the ecosystem tells
you not to run: nothing owns it, and an eviction or node drain deletes
it with no controller to notice. The alternative — a Deployment or
StatefulSet — trades that for the identity problem in §3. Nomad's bend
is two policy fields on a supported job type; Kubernetes' is opting out
of controllers entirely.

## 3. One job per agent, not one job with `count`

`shed()` picks a _specific_ idle `Agent` and disposes it, so the backend
must be able to destroy one worker.

Nomad's group scaling cannot express that. One job with `Count: N` plus
`nomad job scale` decrements a number and the **server** chooses which
allocation dies, so the pool would go on exec'ing into an allocation
Nomad killed while holding a handle to one it believed shed — the two
sets diverge on the first scale-down and never reconverge. Sizing fails
too: allocations in a group share the group's `Resources`, so one job
cannot host the differently-sized agents the pool's size classes exist
to provide. Hence one job per agent, id `${jobId}-${index}`, with
`dispose()` = `nomad job stop -purge -detach <id>` — exact, and about
that agent. The cost is a job id per agent in `nomad status` and one
submit plus placement wait per agent, paid once.

Kubernetes with **bare Pods does not have this hazard**: we name them
and `kubectl delete pod <name>` is exact — a genuine, if small,
advantage. It disappears the moment a controller is involved. A
ReplicaSet scale-down applies its own deletion-cost heuristic (unready
first, then by pod-ready time), which is Nomad's divergence exactly; a
StatefulSet is more predictable — the highest ordinal goes — but
"highest ordinal" is still not "the one the pool sheds", which is
decided by size class and idleness. Any controller-backed agent is the
wrong shape.

## 4. Resource sizing, where Kubernetes is genuinely better

`AgentSpec` is neutral on purpose — CPU **cores** (fractional allowed)
and **bytes** — so one declaration cannot mean two things on two
backends.

Nomad has two CPU knobs and neither is cores-with-fractions. `Cores` is
an integer count of _exclusively reserved_ CPUs, which for whole cores
is arguably better than a Kubernetes CPU limit for a build task: a real
reservation rather than a CFS quota, so it cannot throttle a compile
mid-slice. Below one core there is only `CPU` in **MHz**, and there is
no portable way to learn a client's clock, so `nomadResources()` assumes
**1000 MHz per core** — an explicit assumption at the call site, not a
measurement. Memory is `MemoryMB`, so bytes round to
`max(1, round(bytes / 1 MiB))`.

Kubernetes quantities _are_ cores including fractions (`2`, `500m`) and
memory is plain bytes or a suffixed quantity, so `cores: 0.5` becomes
`500m` with nothing invented in between. This is the one axis on which
Kubernetes is straightforwardly better for what vx needs, and dropping
the backend loses it. The consolation is that fractional-core agents are
the uncommon case — `exec.resources` on a build task is usually whole
CPUs — and that the assumption sits in one function with one test.

## 5. The shared workspace is the load-bearing constraint

vx hashes inputs on the submitting machine, the command reads them on
the agent, and outputs land where vx expects. No Merkle tree, no CAS, no
graft — which is why there is no ~7 s floor, and it means **every agent
must see the same files**. This constrains the backend more than any
scheduling feature does.

On one host it is a bind mount either way: `docker run -v`, Nomad's
docker-driver `Config.volumes`, a Kubernetes `hostPath`. Across real
nodes it needs a network volume every client mounts at the same path — a
Nomad host volume registered per client or a CSI volume; a Kubernetes
**ReadWriteMany** PVC (NFS, CephFS, EFS). That is a change of storage
semantics, not a config detail: a 26 k-file tree over a network
filesystem pays per-file metadata latency on exactly the reads this
design exists to make cheap, and vx's warm-hit check compares size and
millisecond mtime, so coarser mtime granularity is a _correctness_
question and not only a slow one. Agents also share one tree, so nothing
isolates two concurrent tasks from each other's writes; core's hard
project boundaries are what keep that safe, and it is why
`prepareScope` defaults to `'pool'` — eight concurrent installs into one
`node_modules` fight, and the loser reports `EEXIST: failed to symlink
dependencies`.

Plainly: a multi-node agent pool is correct only on a shared filesystem
every node mounts at the same path with sane metadata, and vx does not
paper over its absence — a task whose files are not there fails on its
first command. Anyone wanting nodes without shared storage wants
`@vzn/vx-reapi`, which ships inputs by design. That is the axis on which
to choose between the two plugins.

## 6. Operational surface, and why both shell out to a CLI

Nomad is a single Go binary; `nomad agent -dev` is a working cluster on
a laptop with no ACLs to configure, and the backend needs four commands:
`job run`, `job allocs -json`, `alloc exec`, `job stop -purge`.
Kubernetes needs an API server, etcd, a kubelet and a CNI; a kubeconfig;
and RBAC granting `pods` **and** the `pods/exec` subresource, which is
separately named and commonly denied precisely because it is remote code
execution in a namespace. For a developer's machine or a small
self-hosted build farm, that floor is the deciding practical difference.

Both backends shell out to the CLI rather than vendoring a client, which
is right for this plugin specifically: the surface is four calls, while
a client library is a large dependency tree that must version-match a
server we do not control and would make us reimplement an auth matrix
(kubeconfig contexts, exec credential plugins,
`NOMAD_ADDR`/`NOMAD_TOKEN`, cloud IAM) the CLI already solves and the
operator already maintains — after which failures read as the text they
already see in `nomad status`. The cost, named: one subprocess per exec
(inside the measured ~30 ms), no structured errors, and two narrow
output contracts — `nomad job allocs -json` filtered on
`ClientStatus === 'running'`, pinned by `runningAllocIds`' test, and the
CLI propagating the remote command's exit code, documented for both and
not yet pinned live here.

## 7. What would bring Kubernetes back, and what it must get right

Four things, none hypothetical: the cluster **already exists** (nobody
installs a second scheduler for a build pool); **autoscaling node
pools**, where cluster-autoscaler or Karpenter provision a node for a
pending Pod while Nomad needs the separate Autoscaler plus a cloud
plugin; **multi-tenancy**, where RBAC on `pods/exec`, `ResourceQuota`,
`LimitRange` and PodSecurity admission are more granular and far more
widely audited than a small Nomad deployment usually runs; and **RWX
storage already provisioned**, which is the constraint §5 says decides
everything. Plus fractional cores with no MHz constant.

A returning backend must: create a **bare Pod** named
`${namePrefix}-${index}`, `restartPolicy: 'Never'`, image entrypoint
overridden by `command: ['sh','-c','sleep infinity']` — never a Job,
never a controller (§3); set `requests` **and** `limits` from
`AgentSpec`, `cores` → `${round(cores*1000)}m` and `bytes` → an integer
byte quantity, sharing no code with `nomadResources` so the MHz
assumption cannot leak; pass `volume` through verbatim so `hostPath`
versus an RWX claim stays the user's decision; wait for readiness with a
bounded `kubectl wait --for=condition=Ready pod/<name> --timeout=…`;
exec via `kubectl exec -n <ns> <pod> -- sh -c …`, reusing the existing
`shellQuote`/`envPrefix` pair rather than copying it, since neither CLI
takes `-e` flags and two copies of a quoting rule agree until they do
not; dispose by exact name with `--wait=false`; treat an evicted Pod as
a task failure naming the pod rather than retrying into a dead one; and
sweep debris at startup by label
(`app.kubernetes.io/managed-by: vx-agents`), because a bare Pod has no
owner and a killed `vx run` leaks it — the analogue of docker's `rm -f`
on name reuse and Nomad's purge.

**Out of scope:** multi-node pools without a shared filesystem (that is
`@vzn/vx-reapi`); autoscaling the cluster in either scheduler;
scheduling policy (bin-packing, spread, affinity) beyond what the job
spec carries; ACL/token management beyond passing the environment
through; and shipping a Kubernetes backend at all until someone has a
cluster to run it against — the last one never was, and that is the
specific reason it is removed rather than kept as a maybe.
