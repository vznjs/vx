import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'bun:test'
import { removeBox } from '../src/harness.ts'

// Nix 2.36 leaves read-only copies of store paths in its build directories;
// a user other than root cannot delete their files until they are writable.
test('a case directory goes with its read-only directories', () => {
  const box = mkdtempSync(path.join(os.tmpdir(), 'conf-rm-'))
  const ro = path.join(box, '.home', 'nix-builds', 'b', 'build')
  mkdirSync(path.join(ro, 'src'), { recursive: true })
  writeFileSync(path.join(ro, 'src', 'f'), 'x')
  chmodSync(path.join(ro, 'src'), 0o555)
  chmodSync(ro, 0o555)
  removeBox(box)
  expect(existsSync(box)).toBe(false)
})
