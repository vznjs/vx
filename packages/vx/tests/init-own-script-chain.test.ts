// A member's script that chains its own scripts (`check: pnpm run build &&
// pnpm run lint`) was mapped verbatim with no word: `vx run check` ran
// `build` as its dependency and again inside the command, and `lint`
// outside the graph (M-41). Its parts that run a task of this package are
// named; the chain's order may matter, so it is not turned into a group.
import { expect, it } from 'bun:test'
import { migrateScripts } from '../src/workspace/migrate-scripts.js'

it("names the parts of a script that run this package's own tasks", () => {
  const scripts: Record<string, string> = {
    build: 'tsc',
    lint: 'eslint .',
    check: 'pnpm run build && pnpm run lint',
    ci: 'npm run lint; vitest',
    release: 'bun run build || exit 1',
    // CONTROLS: a lone delegation is a group, a script no task names, a
    // bare manager command (`bun test` is Bun's runner), and a plain one.
    verify: 'pnpm run lint',
    setup: 'npm run prepare && tsc',
    unit: 'bun test && pnpm run lint',
    plain: 'vite build',
  }
  const plan = migrateScripts([
    {
      name: 'a',
      dir: '/w/packages/a',
      packageJson: { name: 'a', scripts } as never,
      configPath: null,
    },
  ])
  const a = plan.projects.find((p) => p.name === 'a')!
  const own = Object.fromEntries(
    a.tasks.map((t) => [t.name, t.todos.filter((s) => s.includes("this package's own task"))]),
  )
  expect(own).toEqual({
    build: [],
    lint: [],
    check: [
      "`pnpm run build`, `pnpm run lint` run this package's own tasks again inside the command, beside those tasks: name them under dependsOn and drop them from the command",
    ],
    ci: [
      "`npm run lint` runs this package's own task again inside the command, beside that task: name it under dependsOn and drop it from the command",
    ],
    release: [
      "`bun run build` runs this package's own task again inside the command, beside that task: name it under dependsOn and drop it from the command",
    ],
    verify: [],
    setup: [],
    unit: [
      "`pnpm run lint` runs this package's own task again inside the command, beside that task: name it under dependsOn and drop it from the command",
    ],
    plain: [],
  })
  // The lone delegation stays a group over its target.
  expect(a.tasks.find((t) => t.name === 'verify')!.task).toEqual({ dependsOn: ['lint'] })
})
