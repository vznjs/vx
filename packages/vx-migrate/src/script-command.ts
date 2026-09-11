// The command a package.json script becomes. Inlining the body is the
// rule — one process less per task than `<pm> run <name>` — with one
// exception: yarn ≥ 2 runs scripts in its own shell, where `run` is a
// builtin (`run -T rollup -c` is "the root's rollup", `run build:code`
// the sibling script). Inlined into sh that body is `run: command not
// found` in every strapi package (2026-09-11), so such a script runs
// through `yarn run <name>`, exactly as Nx's run-script executor and
// Turbo run it.

const YARN_RUN_BUILTIN = /(^|&&|\|\||;|\(|\|)\s*run\s/

export function scriptCommand(name: string, body: string): string {
  return YARN_RUN_BUILTIN.test(body) ? `yarn run ${name}` : body
}
