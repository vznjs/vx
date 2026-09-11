// The command a package.json script becomes. Inlining the body is the
// rule — one process less per task than `<pm> run <name>` — with two npm
// conventions mapped rather than lost, the way core's `vx init` maps
// them (workspace/migrate-scripts.ts):
//
// - `pre<name>` / `post<name>` hooks, which npm and pnpm run around
//   `<name>` without being asked, are folded into the command in that
//   order (novu's `prebuild` copies the CSS its `build` inlines,
//   2026-09-11; Nx and Turbo run `pnpm run build`, so they get the hooks
//   for free). Lifecycle hooks of the package manager's own verbs
//   (`preinstall`, `prepublishOnly`, …) never ride inside a task.
// - yarn ≥ 2 runs scripts in its own shell, where `run` is a builtin
//   (`run -T rollup -c` is "the root's rollup", `run build:code` the
//   sibling script); inlined into sh that body is `run: command not
//   found` in every strapi package (2026-09-11), so such a script runs
//   through `yarn run <name>`, exactly as Nx and Turbo run it — and yarn
//   ≥ 2 runs no pre/post hooks, so none are folded there either.

const YARN_RUN_BUILTIN = /(^|&&|\|\||;|\(|\|)\s*run\s/
const LIFECYCLE = /^(pre|post)(install|publish|pack|version)$|^(prepare|prepublishOnly|install)$/

function usable(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function scriptCommand(
  name: string,
  body: string,
  scripts: Readonly<Record<string, unknown>> = {},
): string {
  const hook = (h: string): string | undefined =>
    !LIFECYCLE.test(h) && usable(scripts[h]) ? scripts[h] : undefined
  const parts = [hook(`pre${name}`), body, hook(`post${name}`)]
  if (parts.some((p) => p !== undefined && YARN_RUN_BUILTIN.test(p))) return `yarn run ${name}`
  return parts.filter((p): p is string => p !== undefined).join(' && ')
}
