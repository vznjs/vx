// `vx lock --help` promised a "file-changed hash report": the lock holds no
// file hashes (version 4 holds resolved configs by directory), so --check
// prints none. The help names what the audit does.
import { expect, it } from 'bun:test'
import { verbHelpText } from '../src/cli/help.js'

it('vx lock --help describes the audit the lock can do', () => {
  const help = verbHelpText('lock')
  expect(help).not.toContain('hash')
  expect(help).toContain('re-evaluate')
})
