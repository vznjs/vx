// What the playground's config rewrite reads as an import (item 699). The
// page evaluates a reader's `vx.config.mjs` alone, so its one allowed
// import, `@vzn/vx`, is pointed at the identity module and every other one
// is refused by name; a specifier that only LOOKS like an import (in a
// comment, a string, a template, a regular expression, a member call) is
// left alone. Evaluation itself, against the CLI, is core's parity file
// (packages/vx/tests/playground-parity.unsafe.test.ts).

import { describe, expect, it } from 'bun:test'
import { rewriteConfigImports } from '../src/playground/config-eval.js'

const URL = 'blob:vx'
const ONLY_VX = 'the playground evaluates a config on its own: it can import only @vzn/vx'

const rewrite = (text: string) => rewriteConfigImports(text, URL)

describe('the playground rewrites @vzn/vx to the identity module', () => {
  const rows: Array<[string, string, string]> = [
    [
      'single quotes',
      "import { defineProject } from '@vzn/vx'\nexport default defineProject({})\n",
      'import { defineProject } from "blob:vx"\nexport default defineProject({})\n',
    ],
    [
      'double quotes',
      'import { defineProject } from "@vzn/vx"\n',
      'import { defineProject } from "blob:vx"\n',
    ],
    [
      'no space before the specifier',
      'import{defineProject}from"@vzn/vx"',
      'import{defineProject}from"blob:vx"',
    ],
    [
      'a clause over several lines, with a comment',
      "import {\n  defineProject, // the one we need\n  defineWorkspace,\n} from '@vzn/vx'\n",
      'import {\n  defineProject, // the one we need\n  defineWorkspace,\n} from "blob:vx"\n',
    ],
    ['a namespace import', "import * as vx from '@vzn/vx'", 'import * as vx from "blob:vx"'],
    [
      'a default and named import',
      "import vx, { defineProject } from '@vzn/vx'",
      'import vx, { defineProject } from "blob:vx"',
    ],
    [
      'a re-export',
      "export { defineProject } from '@vzn/vx'",
      'export { defineProject } from "blob:vx"',
    ],
    [
      'a literal dynamic import',
      "const vx = await import('@vzn/vx')",
      'const vx = await import("blob:vx")',
    ],
  ]
  for (const [name, text, expected] of rows) {
    it(name, () => {
      expect(rewrite(text)).toEqual({ ok: true, text: expected })
    })
  }
})

describe('a specifier that is not an import is left alone', () => {
  const rows: Array<[string, string]> = [
    ['in a line comment', "// import fs from 'node:fs'\nexport default {}\n"],
    [
      'in a block comment',
      "/* import './preset.mjs'\n   export * from './x' */\nexport default {}\n",
    ],
    ['in a string', `const s = "import fs from 'node:fs'" + 'export * from "./x"'\n`],
    ['in a template', "const s = `import('node:fs')`\n"],
    ['in a template, after an expression', "const s = `${{ a: 1 }.a} import('node:fs')`\n"],
    ['in a regular expression', "const re = /import('node:fs')/\n"],
    ['in a regular expression after return', "function f() { return /import 'node:fs'/ }\n"],
    ['a member call named import', "loader.import('node:fs')\n"],
    ['a property named import', "const o = { import: 'node:fs' }\n"],
    ['import.meta', 'const u = import.meta.url\n'],
    ['a local export list', "const a = 1\nexport { a }\nconst b = 'node:fs'\n"],
  ]
  for (const [name, text] of rows) {
    it(name, () => {
      expect(rewrite(text)).toEqual({ ok: true, text })
    })
  }
})

describe('every other import is refused by name', () => {
  const rows: Array<[string, string, string]> = [
    ['a builtin', "import fs from 'node:fs'\n", 'node:fs'],
    ['a relative file', "import preset from './preset.mjs'\n", './preset.mjs'],
    ['a side-effect import', 'import "./setup.mjs"\n', './setup.mjs'],
    ['export * from', "export * from './preset.mjs'\n", './preset.mjs'],
    ['export { … } from, double-quoted', 'export { a } from "./preset.mjs"\n', './preset.mjs'],
    ['a literal dynamic import', "const fs = await import('node:fs')\n", 'node:fs'],
    ['a subpath of @vzn/vx', "import { x } from '@vzn/vx/internal'\n", '@vzn/vx/internal'],
    ['an escaped @vzn/vx', "import { x } from '\\u0040vzn/vx'\n", '\\u0040vzn/vx'],
    ['a comment before the specifier', "import fs from /* why */ 'node:fs'\n", 'node:fs'],
    ['inside a template expression', "const s = `${await import('node:fs')}`\n", 'node:fs'],
    [
      'after an allowed one',
      "import { defineProject } from '@vzn/vx'\nimport preset from '../preset.mjs'\n",
      '../preset.mjs',
    ],
    // The one known misreading: a `/` after `)` is a division, so a
    // regular expression there is read as code.
    ['a regular expression after `)`', "if (x) /import('node:fs')/.test(s)\n", 'node:fs'],
  ]
  for (const [name, text, spec] of rows) {
    it(name, () => {
      expect(rewrite(text)).toEqual({ ok: false, error: `cannot import '${spec}': ${ONLY_VX}` })
    })
  }

  it('a computed dynamic import', () => {
    expect(rewrite('const m = await import(name)\n')).toEqual({
      ok: false,
      error: `cannot evaluate a computed import(): ${ONLY_VX}`,
    })
  })
})
