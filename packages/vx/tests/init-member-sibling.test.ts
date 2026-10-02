// A member's script that runs another member's work gets a TODO naming
// that part: mapped verbatim it ran the sibling's task again outside the
// graph (pinia's online-playground `build`).
import { expect, it } from 'bun:test'
import { migrateScripts } from '../src/workspace/migrate-scripts.js'

const meta = (name: string, dir: string, scripts: Record<string, string>) => ({
  name,
  dir,
  packageJson: { name, scripts } as never,
  configPath: null,
})

it("names the part of a member's script that runs a sibling's work", () => {
  const scripts: Record<string, string> = {
    // pinia, cal.com/react, kit, headlessui, pnpm/pnpm, a `cd`.
    dashC: 'pnpm -C ../pinia run build && vite build',
    dir: 'pnpm --dir=../pinia build',
    workspace: 'yarn workspace pinia build && tsc',
    recursive: 'pnpm -r --filter="./test/**" test',
    npmWorkspace: 'npm run dev --workspace=play',
    filter: 'pn --filter=pinia compile && pn .test',
    cd: 'cd ../pinia && tsdown',
    // A nested member is another member too (kit's test apps).
    nested: 'cd test/app && vite build',
    // CONTROLS: a fixture inside the member, the root, the member itself,
    // a directory vx cannot read, and a plain script.
    fixture: 'pnpm install -C test/fixture --force',
    root: "yarn --cwd='../..' jest packages/app",
    self: 'pnpm -C . build',
    unread: 'cd $DIR && make',
    plain: 'vite build',
  }
  const plan = migrateScripts([
    meta('pinia', '/w/packages/pinia', { build: 'tsdown' }),
    meta('app', '/w/packages/app', scripts),
    meta('test-app', '/w/packages/app/test/app', { build: 'vite build' }),
  ])
  const app = plan.projects.find((p) => p.name === 'app')!
  const named = Object.fromEntries(
    app.tasks.map((t) => [
      t.name,
      t.todos.map((s) => /^`([^`]*)` runs another member/.exec(s)?.[1]),
    ]),
  )
  expect(named).toEqual({
    dashC: ['pnpm -C ../pinia run build'],
    dir: ['pnpm --dir=../pinia build'],
    workspace: ['yarn workspace pinia build'],
    recursive: ['pnpm -r --filter="./test/**" test'],
    npmWorkspace: ['npm run dev --workspace=play'],
    filter: ['pn --filter=pinia compile'],
    cd: ['cd ../pinia'],
    nested: ['cd test/app'],
    fixture: [],
    root: [],
    self: [],
    unread: [],
    plain: [],
  })
  expect(app.tasks.find((t) => t.name === 'dashC')!.todos[0]).toBe(
    "`pnpm -C ../pinia run build` runs another member's work outside the graph, again beside that member's own task: name that task under dependsOn (`<member>#<task>`) and drop it from the command",
  )
  // The command stays as written.
  expect(app.tasks.find((t) => t.name === 'dashC')!.task).toEqual({
    exec: { command: 'pnpm -C ../pinia run build && vite build' },
  })
})
