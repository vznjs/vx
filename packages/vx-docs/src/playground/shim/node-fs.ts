// `node:fs` for the playground bundle: the reads the planner makes, over the
// active VFS. Every other export a bundled module names exists only so the
// bundle links; calling one is a claim the plan path is wrong about, so it
// throws with the name.

import { enoent, vfs, type VfsStats } from './vfs.js'

function notInPlayground(name: string): () => never {
  return () => {
    throw new Error(`playground: node:fs ${name} is not available (the plan should not reach it)`)
  }
}

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

export const readlinkSync = notInPlayground('readlinkSync')
export const accessSync = notInPlayground('accessSync')
export const mkdirSync = notInPlayground('mkdirSync')
export const writeFileSync = notInPlayground('writeFileSync')
export const readdirSync = notInPlayground('readdirSync')
export const realpathSync = notInPlayground('realpathSync')
export const rmSync = notInPlayground('rmSync')
export const renameSync = notInPlayground('renameSync')
export const writeSync = notInPlayground('writeSync')
export const closeSync = notInPlayground('closeSync')
export const unlinkSync = notInPlayground('unlinkSync')
export const symlinkSync = notInPlayground('symlinkSync')
export const chmodSync = notInPlayground('chmodSync')
export const mkdtempSync = notInPlayground('mkdtempSync')
export const appendFileSync = notInPlayground('appendFileSync')
export const utimesSync = notInPlayground('utimesSync')
export const watch = notInPlayground('watch')
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 }
export const promises = {}

export default {
  lstatSync,
  statSync,
  existsSync,
  readFileSync,
}
