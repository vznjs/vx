#!/bin/bash
# vx (compiled binary + @vzn/vx-turbo on the repo's own turbo.json) against
# the repo's own Turbo, on a real Turbo monorepo. Three arms per tool,
# interleaved (vx, turbo, vx, turbo …) so box noise lands on both:
#   cold     caches AND outputs wiped — every task executes
#   restore  outputs wiped, caches intact — every task a hit, outputs come back
#   noop     nothing wiped — every task a hit over intact outputs
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
# the repo's own script passes turbo (medusa: `--concurrency=100%`).
set -u
R=$1; VX=$2; TASKS=$3; REPS=${4:-3}; DIRS=${5:-"dist types coverage"}
FILTERS=${FILTERS:-}; TURBO_ARGS=${TURBO_ARGS:-}
vx_scope=(--all); turbo_scope=()
if [ -n "$FILTERS" ]; then
  vx_scope=()
  set -f  # `@astrojs/*` is a filter, not a path
  for f in $FILTERS; do vx_scope+=(--filter "$f"); turbo_scope+=("--filter=$f"); done
  set +f
fi
cd "$R"
outputs() {
  local args=()
  for d in $DIRS; do args+=(-o -name "$d"); done
  find packages -path '*/node_modules' -prune -o \( -type d \( -false "${args[@]}" \) \) -print
}
wipe_outputs() { outputs | xargs -r rm -rf; }
wipe_turbo_cache() { rm -rf node_modules/.cache/turbo .turbo packages/*/.turbo; }
wipe_vx_cache() { rm -rf .vx; }
ms() { date +%s%N; }
run_vx() { "$VX" run $TASKS "${vx_scope[@]}" > .vx-bench-vx.log 2>&1; echo $?; }
run_turbo() { node_modules/.bin/turbo run $TASKS "${turbo_scope[@]}" $TURBO_ARGS --no-daemon > .vx-bench-turbo.log 2>&1; echo $?; }
time_arm() {
  local t0 t1 code
  t0=$(ms); code=$(run_"$1"); t1=$(ms)
  echo "$1 $2 $(( (t1 - t0) / 1000000 )) ms exit=$code"
}
for _ in $(seq 1 "$REPS"); do
  for tool in vx turbo; do
    wipe_outputs; wipe_turbo_cache; wipe_vx_cache
    time_arm $tool cold
    wipe_outputs
    time_arm $tool restore
    time_arm $tool noop
  done
done
