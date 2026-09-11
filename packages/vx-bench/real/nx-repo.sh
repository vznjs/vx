#!/bin/bash
# vx (compiled binary, on the vx.config.ts files `bunx @vzn/vx-migrate
# --from nx` wrote from the repo's own Nx graph) against the repo's own Nx,
# on a real Nx monorepo. The four arms of turbo-repo.sh, per tool, vx first:
#   cold     caches AND outputs wiped — every task executes
#   restore  outputs wiped, caches intact — every task a hit, outputs come back
#   noop     nothing wiped — every task a hit over intact outputs
#   noop2    the same again
#
#   real/nx-repo.sh <repo> <vx-binary> "<tasks>" [reps]
#
# The repo must be installed, its graph exported
# (`nx graph --file=.nx/workspace-data/project-graph.json`) and migrated
# (`bun packages/vx-migrate/src/bin.ts --from nx` from the repo root),
# so the vx.config.ts files sit beside the package.json files; they are
# untracked, not ignored, and survive the clean. Rows print as
# `<tool> <arm> <ms> exit=<code>`; each arm's log is kept beside the repo
# as .vx-bench-<tool>-<arm>.log.
#
# Nx runs with NX_DAEMON=false (the bench measures the runner, not a
# resident process the repo's CI would not have either) through the
# repo's own `node_modules/.bin/nx`. Its local cache is `.nx/cache`
# (older releases: `node_modules/.cache/nx`); its graph cache lives in
# `.nx/workspace-data` and is wiped with the task cache on a cold arm,
# as vx's config cache in `.vx` is. FILTERS scopes both tools alike:
# a pattern is a project for vx `--filter` and nx `--projects`; a
# negated one (`!examples/*`) is vx `--filter '!…'` and nx `--exclude`.
# NX_ARGS / VX_ARGS add what the repo's own script passes.
set -u
R=$1; VX=$2; TASKS=$3; REPS=${4:-3}
FILTERS=${FILTERS:-}; NX_ARGS=${NX_ARGS:-}; VX_ARGS=${VX_ARGS:-}
vx_scope=(--all); nx_scope=()
if [ -n "$FILTERS" ]; then
  vx_scope=(); projects=""; excludes=""
  set -f
  for f in $FILTERS; do
    vx_scope+=(--filter "$f")
    case $f in
      !*) excludes="${excludes:+$excludes,}${f#!}" ;;
      *) projects="${projects:+$projects,}$f" ;;
    esac
  done
  set +f
  [ -n "$projects" ] && nx_scope+=(--projects="$projects")
  [ -n "$excludes" ] && nx_scope+=(--exclude="$excludes")
fi
cd "$R"
export PATH="$R/node_modules/.bin:$PATH"
export NX_DAEMON=false
# Everything git ignores except the installs, the two caches and the
# arm logs; see turbo-repo.sh for why less than this leaks between arms.
wipe_outputs() {
  git clean -fdXq -e '!node_modules' -e '!**/node_modules/**' -e '!.vx' -e '!.vx/**' \
    -e '!.env*' -e '!.yarn' -e '!.yarn/**' -e '!.husky' -e '!.husky/**' -e '!.nx' -e '!.nx/**' \
    -e '!.vx-bench-*'
}
wipe_nx_cache() { rm -rf .nx/cache .nx/workspace-data node_modules/.cache/nx; }
wipe_vx_cache() { rm -rf .vx; }
ms() { date +%s%N; }
run_vx() { "$VX" run $TASKS "${vx_scope[@]}" $VX_ARGS > ".vx-bench-vx-$1.log" 2>&1; echo $?; }
run_nx() { node_modules/.bin/nx run-many -t $TASKS "${nx_scope[@]}" $NX_ARGS > ".vx-bench-nx-$1.log" 2>&1; echo $?; }
time_arm() {
  local t0 t1 code
  t0=$(ms); code=$(run_"$1" "$2"); t1=$(ms)
  echo "$1 $2 $(( (t1 - t0) / 1000000 )) ms exit=$code"
}
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
  for tool in vx nx; do
    arm $tool cold wipe_outputs wipe_nx_cache wipe_vx_cache
    arm $tool restore wipe_outputs
    arm $tool noop
    arm $tool noop2
  done
  SKIP_ARMS=0; arm_index=0
done
