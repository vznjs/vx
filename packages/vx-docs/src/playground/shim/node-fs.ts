// `node:fs` for the playground bundle: the reads the planner makes, over the
// active VFS. Every other export a bundled module names exists only so the
// bundle links; calling one is a claim the plan path is wrong about, so it
// throws with the name.

import { notInPlayground } from './unavailable.js'
import { enoent, vfs, type VfsStats } from './vfs.js'

export function lstatSync(p: string, opts?: { throwIfNoEntry?: boolean }): VfsStats | undefined {
  const st = vfs().stat(p)
  if (st === undefined) {
    if (opts?.throwIfNoEntry === false) return undefined
    throw enoent('lstat', p)
  }
  return st
}

export const statSync = lstatSync

export function existsSync(p: string): boolean {
  return vfs().stat(p) !== undefined
}

export function readFileSync(p: string, enc?: string): Uint8Array | string {
  const bytes = vfs().read(p)
  if (bytes === undefined) throw enoent('open', p)
  return enc === undefined ? bytes : new TextDecoder().decode(bytes)
}

export const readlinkSync = notInPlayground('readlinkSync', 'node:fs')
export const accessSync = notInPlayground('accessSync', 'node:fs')
export const mkdirSync = notInPlayground('mkdirSync', 'node:fs')
export const writeFileSync = notInPlayground('writeFileSync', 'node:fs')
export const readdirSync = notInPlayground('readdirSync', 'node:fs')
export const realpathSync = notInPlayground('realpathSync', 'node:fs')
export const rmdirSync = notInPlayground('rmdirSync', 'node:fs')
export const rmSync = notInPlayground('rmSync', 'node:fs')
export const renameSync = notInPlayground('renameSync', 'node:fs')
export const writeSync = notInPlayground('writeSync', 'node:fs')
export const closeSync = notInPlayground('closeSync', 'node:fs')
export const unlinkSync = notInPlayground('unlinkSync', 'node:fs')
export const symlinkSync = notInPlayground('symlinkSync', 'node:fs')
export const linkSync = notInPlayground('linkSync', 'node:fs')
export const chmodSync = notInPlayground('chmodSync', 'node:fs')
export const mkdtempSync = notInPlayground('mkdtempSync', 'node:fs')
export const appendFileSync = notInPlayground('appendFileSync', 'node:fs')
export const utimesSync = notInPlayground('utimesSync', 'node:fs')
export const openSync = notInPlayground('openSync', 'node:fs')
export const fstatSync = notInPlayground('fstatSync', 'node:fs')
export const watch = notInPlayground('watch', 'node:fs')
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 }
export const promises = {}

export default {
  lstatSync,
  statSync,
  existsSync,
  readFileSync,
}
