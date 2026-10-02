// An executor the migrator cannot write as a command, from an Nx plugin
// that ships `convert-to-inferred`, names that generator (P2-4): Webpack's
// and Rollup's executors feed their options to the project's config
// function, and the generator is Nx's own way to move them there.

import { describe, expect, it } from 'bun:test'
import { untranslatedTodo } from '../src/nx/nx-native.js'

const hint = (plugin: string, executor: string) =>
  `executor "${executor}" has no plain command here — \`nx g ${plugin}:convert-to-inferred\` ` +
  'rewrites it as the command Nx infers; run it and migrate again, or replace the placeholder with the line it runs'

describe('untranslated executors', () => {
  it('a Webpack or Rollup executor names its plugin’s generator', () => {
    expect(untranslatedTodo('@nx/webpack:webpack')).toBe(hint('@nx/webpack', '@nx/webpack:webpack'))
    expect(untranslatedTodo('@nx/webpack:ssr-dev-server')).toBe(
      hint('@nx/webpack', '@nx/webpack:ssr-dev-server'),
    )
    expect(untranslatedTodo('@nx/rollup:rollup')).toBe(hint('@nx/rollup', '@nx/rollup:rollup'))
  })

  it('the @nrwl scope names the @nx generator', () => {
    expect(untranslatedTodo('@nrwl/webpack:webpack')).toBe(
      hint('@nx/webpack', '@nrwl/webpack:webpack'),
    )
  })

  it('a plugin with no such generator is the plain TODO', () => {
    for (const e of ['@nx/angular:application', '@nx/esbuild:esbuild', '@acme/tool:run'])
      expect(untranslatedTodo(e)).toBe(
        `executor "${e}" has no plain command here — replace the placeholder with the line it runs`,
      )
  })
})
