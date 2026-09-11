#!/bin/bash
# vx (compiled binary + @vzn/vx-turbo on the repo's own turbo.json) against
# the repo's own Turbo, on a real Turbo monorepo. Three arms per tool,
# interleaved (vx, turbo, vx, turbo …) so box noise lands on both:
#   cold     caches AND outputs wiped — every task executes
#   restore  outputs wiped, caches intact — every task a hit, outputs come back
#   noop     nothing wiped — every task a hit over intact outputs
#   noop2    the same again: a runner whose outputs are its own inputs
#            (Turbo on an explicit `inputs: ["**/*"]` hashes its restored
#            `dist/**`, so its first run after a restore rebuilds — astro,
#            2026-09-11) stabilizes only here
#
#   real/turbo-repo.sh <repo> <vx-binary> "<tasks>" [reps] [output-dir-names]
#
# The repo must already have `vx.workspace.mjs` with `plugins: [turbo()]`
# and its dependencies installed. `output-dir-names` is what the wipe
# removes under packages/*/ (default: dist types coverage). Rows print as
# `<tool> <arm> <ms> exit=<code>`; run each tool's last log is kept beside
# the repo as .vx-bench-<tool>.log. First run: solidjs/solid, 2026-09-10,
# recorded in packages/vx/docs/benchmarks.md. Next target (owner,
# 2026-09-11: "solid is too small"): n8n-io/n8n — the most-starred
# Turborepo monorepo (204k), 84 workspace packages, 71 `build` tasks,
# 274 across build + typecheck + test:unit + lint; needs Node >= 24 and
# pnpm 12 on the bench host:
#   git clone --depth 1 https://github.com/n8n-io/n8n && cd n8n && pnpm install
#   printf "import { turbo } from '@vzn/vx-turbo'\nexport default { plugins: [turbo()] }\n" > vx.workspace.mjs
#   real/turbo-repo.sh ~/n8n <vx-binary> "build" 3 "dist"
#   real/turbo-repo.sh ~/n8n <vx-binary> "build typecheck test:unit lint" 3 "dist coverage"
#
# FILTERS="astro @astrojs/*" scopes BOTH tools to the same packages (vx
# `--filter <p>` per pattern instead of `--all`, turbo `--filter=<p>`), for
# a repo whose own `build` script is a filtered `turbo run build`; a
# pattern may be negated (`!@payloadcms/plugin-*`). TURBO_ARGS adds what
# the repo's own script passes turbo (medusa: `--concurrency=100%`);
# VX_ARGS the same for vx — Turbo's default is 10 workers whatever the
# core count, vx's is the core count, so a matched run passes vx
# `--concurrency 10` (astro cold on four cores: 70.5 s at 4 workers,
# 53.8 s at 8; payload 120 s at 4, 128 s at 8 — 2026-09-11).
set -u
R=$1; VX=$2; TASKS=$3; REPS=${4:-3}
FILTERS=${FILTERS:-}; TURBO_ARGS=${TURBO_ARGS:-}; VX_ARGS=${VX_ARGS:-}
vx_scope=(--all); turbo_scope=()
if [ -n "$FILTERS" ]; then
  vx_scope=()
  set -f  # `@astrojs/*` is a filter, not a path
  for f in $FILTERS; do vx_scope+=(--filter "$f"); turbo_scope+=("--filter=$f"); done
  set +f
fi
cd "$R"
# The repo's own `build` script runs Turbo through its package manager
# (`yarn build` → `turbo run …`), which puts the root `node_modules/.bin`
# on PATH for every task; run bare, Turbo left medusa's `@medusajs/icons`
# without the root's `rollup` (exit 127, 2026-09-11). vx exposes the bin
# dirs itself; the same PATH for both tools is the same footing.
export PATH="$R/node_modules/.bin:$PATH"
# Full artifact cleanup: everything git ignores under the repo except the
# installs (`node_modules`, `.yarn`), the two caches (`.vx`, and `.turbo`
# — Turbo 2 keeps its local cache in `.turbo/cache`; both wiped
# separately for a cold arm) and `.env*`. Turbo does not clean outputs
# before a run and vx cleans only a task's declared ones, so anything
# short of this leaks between arms and tools — Turbo's `.turbo` logs,
# astro's prebuilt files, payload's `.swc` caches and 42 stale
# `tsconfig.tsbuildinfo` files that made the next incremental tsc skip
# its declaration emit (TS6305 in every dependant, 2026-09-11).
wipe_outputs() {
  git clean -fdXq -e '!node_modules' -e '!**/node_modules/**' -e '!.vx' -e '!.vx/**' \
    -e '!.env*' -e '!.yarn' -e '!.yarn/**' -e '!.husky' -e '!.husky/**' -e '!.turbo' -e '!.turbo/**'
}
wipe_turbo_cache() { rm -rf node_modules/.cache/turbo .turbo packages/*/.turbo; }
wipe_vx_cache() { rm -rf .vx; }
ms() { date +%s%N; }
run_vx() { "$VX" run $TASKS "${vx_scope[@]}" $VX_ARGS > .vx-bench-vx.log 2>&1; echo $?; }
run_turbo() { node_modules/.bin/turbo run $TASKS "${turbo_scope[@]}" $TURBO_ARGS --no-daemon > .vx-bench-turbo.log 2>&1; echo $?; }
time_arm() {
  local t0 t1 code
  t0=$(ms); code=$(run_"$1"); t1=$(ms)
  echo "$1 $2 $(( (t1 - t0) / 1000000 )) ms exit=$code"
}
# SKIP_ARMS=n resumes a rep at its n-th arm (of the eight: four per tool,
# vx first): every arm's precondition is on disk (the caches persist
# between arms), so a driver that lost a process mid-rep restarts at the
# arm it lost instead of the rep.
SKIP_ARMS=${SKIP_ARMS:-0}
arm_index=0
arm() { # tool name pre-steps...
  local tool=$1 name=$2; shift 2
  local i=$arm_index; arm_index=$(( arm_index + 1 ))
  [ "$i" -lt "$SKIP_ARMS" ] && return
  for pre in "$@"; do $pre; done
  time_arm "$tool" "$name"
}
for _ in $(seq 1 "$REPS"); do
  for tool in vx turbo; do
    arm $tool cold wipe_outputs wipe_turbo_cache wipe_vx_cache
    arm $tool restore wipe_outputs
    arm $tool noop
    arm $tool noop2
  done
  SKIP_ARMS=0; arm_index=0
done
