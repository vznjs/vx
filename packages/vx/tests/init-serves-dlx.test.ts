// A launcher's `--package <name>` / `-p <name>` names what to install, not
// the program: docusaurus's `netlify:test` (`pnpm dlx --package netlify-cli
// netlify dev`) mapped as a one-shot task.
import { expect, it } from 'bun:test'
import { migrateScripts } from '../src/workspace/migrate-scripts.js'

it('reads the program past a launcher’s --package value', () => {
  const scripts: Record<string, string> = {
    netlifyDev: 'pnpm build && pnpm dlx --package netlify-cli netlify dev -- --debug',
    npxP: 'npx -p serve serve dist',
    joined: 'pnpm dlx --package=netlify-cli netlify dev',
    // CONTROLS: a one-shot program behind the same launchers.
    oneShot: 'npx -p typescript tsc -b',
    dlxBuild: 'pnpm dlx --package netlify-cli netlify build',
  }
  const tasks = migrateScripts([
    { name: 'a', dir: '/w/a', packageJson: { name: 'a', scripts } as never, configPath: null },
  ]).projects[0]!.tasks
  expect(
    Object.fromEntries(
      tasks.map((t) => [
        t.name,
        (t.task?.['exec'] as { persistent?: unknown } | undefined)?.persistent !== undefined,
      ]),
    ),
  ).toEqual({ netlifyDev: true, npxP: true, joined: true, oneShot: false, dlxBuild: false })
})
