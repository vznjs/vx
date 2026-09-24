// The workspace both planners see in the playground's parity rows
// (packages/vx/tests/playground-parity.unsafe.test.ts; spike item 676), and
// the one the playground opens with.
//
// Five projects: a dependency chain (utils ← core ← ui ← app) plus an
// unrelated `docs`. It covers `^build` and same-project `dependsOn`, a
// `pkg#task` edge, cache inputs with a negation and braces, a route
// directory with LITERAL brackets (item 667), `outputs.files`, one
// `cache.inputs.env` entry, one `workspaceFiles` entry, a task with no
// cache block and a group task. Each config is the `vx.config.mjs` source
// a reader edits: the CLI evaluates the file, the playground the same text
// (`evaluateConfig`, item 699).

/** Project name → the source of its `vx.config.mjs`. */
export const CONFIG_TEXTS: Record<string, string> = {
  '@pg/utils': `import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      exec: { command: 'mkdir -p dist && cp src/*.ts dist/' },
      cache: {
        inputs: { files: ['src/**/*.ts'], workspaceFiles: ['tsconfig.base.json'] },
        outputs: { files: ['dist/**'] },
      },
    },
  },
})
`,
  '@pg/core': `import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      dependsOn: ['^build'],
      exec: { command: 'mkdir -p dist && cp src/*.ts dist/' },
      cache: {
        inputs: { files: ['src/**', 'package.json'], env: ['API_URL'] },
        outputs: { files: ['dist'] },
      },
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'true' },
      cache: { inputs: { files: ['src/**', 'test/**'] }, outputs: { files: [] } },
    },
  },
})
`,
  '@pg/ui': `import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      dependsOn: ['^build'],
      exec: { command: 'mkdir -p dist && cp -r src dist/' },
      cache: {
        // [id] is a literal route directory, not a character class.
        inputs: { files: ['src/**/*.{ts,tsx}', '!src/**/*.test.ts', 'src/app/[id]/**'] },
        outputs: { files: ['dist/**'] },
      },
    },
  },
})
`,
  '@pg/app': `import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    codegen: { exec: { command: 'echo generated > gen.txt' } },
    build: {
      dependsOn: ['^build', 'codegen', '@pg/core#test'],
      exec: { command: 'mkdir -p dist && cp src/*.ts dist/', timeout: 60000 },
      cache: {
        inputs: {
          files: ['src/**', 'gen.txt'],
          workspaceFiles: ['tsconfig.base.json', '!**/*.md'],
        },
        outputs: { files: ['dist/**'] },
      },
    },
    ci: { dependsOn: ['build', 'codegen'] },
  },
})
`,
  '@pg/docs': `import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: { exec: { command: 'echo docs' } },
  },
})
`,
}

const pkg = (name: string, deps: Record<string, string> = {}): string =>
  `${JSON.stringify({ name, version: '1.0.0', dependencies: deps }, null, 2)}\n`

/** Root-relative path → contents: the tracked tree of the fixture repository. */
export const FILES: Record<string, string> = {
  '.gitignore': '.vx/\nnode_modules/\ndist/\n',
  'package.json': `${JSON.stringify({ name: 'pg-root', private: true, workspaces: ['packages/*'] }, null, 2)}\n`,
  'bun.lock': '{\n  "lockfileVersion": 1,\n  "workspaces": {}\n}\n',
  'tsconfig.base.json': '{ "compilerOptions": { "strict": true } }\n',
  'README.md': '# playground fixture\n',

  'packages/utils/package.json': pkg('@pg/utils'),
  'packages/utils/vx.config.mjs': CONFIG_TEXTS['@pg/utils']!,
  'packages/utils/src/index.ts': "export * from './strings'\n",
  'packages/utils/src/strings.ts': 'export const shout = (s: string) => s.toUpperCase()\n',
  'packages/utils/README.md': 'utils\n',

  'packages/core/package.json': pkg('@pg/core', { '@pg/utils': 'workspace:*' }),
  'packages/core/vx.config.mjs': CONFIG_TEXTS['@pg/core']!,
  'packages/core/src/index.ts':
    "import { shout } from '@pg/utils'\nexport const hello = () => shout('hi')\n",
  'packages/core/test/index.test.ts': "import { hello } from '../src'\nhello()\n",

  'packages/ui/package.json': pkg('@pg/ui', { '@pg/core': 'workspace:*' }),
  'packages/ui/vx.config.mjs': CONFIG_TEXTS['@pg/ui']!,
  'packages/ui/src/button.tsx': 'export const Button = () => null\n',
  'packages/ui/src/button.test.ts': 'import "./button"\n',
  'packages/ui/src/app/[id]/page.tsx': 'export default function Page() { return null }\n',
  'packages/ui/src/app/i/page.tsx': 'export default function Other() { return null }\n',
  // Only a literal `[id]` reaches the first; only a CLASS `[id]` reaches the second.
  'packages/ui/src/app/[id]/meta.json': '{ "route": true }\n',
  'packages/ui/src/app/d/data.json': '{ "route": false }\n',

  'packages/app/package.json': pkg('@pg/app', {
    '@pg/ui': 'workspace:*',
    '@pg/core': 'workspace:*',
  }),
  'packages/app/vx.config.mjs': CONFIG_TEXTS['@pg/app']!,
  'packages/app/src/main.ts': "import { Button } from '@pg/ui'\nButton()\n",
  'packages/app/gen.txt': 'generated\n',

  'packages/docs/package.json': pkg('@pg/docs'),
  'packages/docs/vx.config.mjs': CONFIG_TEXTS['@pg/docs']!,
  'packages/docs/index.md': '# docs\n',
}

export const ENV = { API_URL: 'https://api.example.test' }
