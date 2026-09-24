// The workspace the playground page opens with (guide/try-it, item 700;
// design/playground-ui-2026-09.md): the Guide's toy monorepo, as files.
//
// `utils`; `ui` and `api`, which both use `utils`; `app`, which uses `ui`
// and `api`; each with `build` and `test`, wired by `^build` and `build`.
// `app` also declares `app#docs`, which nothing waits on and which the page
// does not run: the default run is `build test`, the command the Guide's
// last chapter gives, so its eight tasks are the book's four packages; a
// reader who types `docs` gets it. Every task declares the files it reads,
// so which keys an edit moves is what the Guide teaches: editing
// `packages/ui/src/button.tsx` moves `ui#build`, `ui#test`, `app#build` and
// `app#test`, and nothing else. Core's parity row
// (packages/vx/tests/playground-parity.unsafe.test.ts) holds this plan to
// `vx run build test --all --dry=json` over the same files, committed.

const configText = (
  build: string,
  env = '',
  more = '',
): string => `import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      dependsOn: ['^build'],
      exec: { command: '${build}' },
      cache: {
        inputs: { files: ['src/**']${env} },
        outputs: { files: ['dist/**'] },
      },
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'bun test' },
      cache: {
        inputs: { files: ['src/**', 'test/**'] },
        outputs: { files: [] },
      },
    },${more}
  },
})
`

/** Project name → the source of its `vx.config.mjs`. */
export const CONFIG_TEXTS: Record<string, string> = {
  utils: configText('tsc -b'),
  ui: configText('vite build'),
  api: configText('bun build src/server.ts --outdir dist', ", env: ['API_URL']"),
  app: configText(
    'vite build',
    '',
    `
    docs: {
      exec: { command: 'astro build --root docs' },
      cache: {
        inputs: { files: ['docs/src/**'] },
        outputs: { files: ['docs/dist/**'] },
      },
    },`,
  ),
}

const pkg = (name: string, uses: string[] = []): string =>
  `${JSON.stringify(
    {
      name,
      version: '1.0.0',
      dependencies: Object.fromEntries(uses.map((u) => [u, 'workspace:*'])),
    },
    null,
    2,
  )}\n`

/** Root-relative path → contents: the workspace as the page opens it. */
export const FILES: Record<string, string> = {
  '.gitignore': '.vx/\nnode_modules/\ndist/\n',
  'package.json': `${JSON.stringify({ name: 'toy', private: true, workspaces: ['packages/*'] }, null, 2)}\n`,
  'bun.lock': '{\n  "lockfileVersion": 1,\n  "workspaces": {}\n}\n',

  'packages/utils/package.json': pkg('utils'),
  'packages/utils/vx.config.mjs': CONFIG_TEXTS['utils']!,
  'packages/utils/src/index.ts': 'export const shout = (s: string) => s.toUpperCase()\n',
  'packages/utils/test/index.test.ts':
    "import { expect, test } from 'bun:test'\nimport { shout } from '../src'\n\ntest('shout', () => expect(shout('hi')).toBe('HI'))\n",

  'packages/ui/package.json': pkg('ui', ['utils']),
  'packages/ui/vx.config.mjs': CONFIG_TEXTS['ui']!,
  'packages/ui/src/button.tsx':
    "import { shout } from 'utils'\n\nexport const Button = ({ label }: { label: string }) => <button>{shout(label)}</button>\n",
  'packages/ui/test/button.test.tsx':
    "import { expect, test } from 'bun:test'\nimport { Button } from '../src/button'\n\ntest('Button', () => expect(Button({ label: 'ok' })).toBeDefined())\n",

  'packages/api/package.json': pkg('api', ['utils']),
  'packages/api/vx.config.mjs': CONFIG_TEXTS['api']!,
  'packages/api/src/server.ts':
    "import { shout } from 'utils'\n\nexport const greet = (name: string) => shout(`hello, ${name}`)\n",
  'packages/api/test/server.test.ts':
    "import { expect, test } from 'bun:test'\nimport { greet } from '../src/server'\n\ntest('greet', () => expect(greet('you')).toBe('HELLO, YOU'))\n",

  'packages/app/package.json': pkg('app', ['ui', 'api']),
  'packages/app/vx.config.mjs': CONFIG_TEXTS['app']!,
  'packages/app/src/main.tsx':
    "import { greet } from 'api'\nimport { Button } from 'ui'\n\nexport const App = () => <Button label={greet('reader')} />\n",
  'packages/app/test/main.test.tsx':
    "import { expect, test } from 'bun:test'\nimport { App } from '../src/main'\n\ntest('App', () => expect(App()).toBeDefined())\n",
  'packages/app/docs/src/index.md': '# The toy monorepo\n',
}

/** The environment the page opens with: `api#build` declares `API_URL`. */
export const ENV: Record<string, string> = { API_URL: 'https://api.example.com' }

/** The file the editor opens on: the one the Guide's last chapter edits. */
export const OPEN = 'packages/ui/src/button.tsx'

/** The task specs the page runs, as `vx run build test` takes them. */
export const TASKS = ['build', 'test']
