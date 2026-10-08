// `node:fs/promises` for the playground bundle; see node-fs.ts.

import { notInPlayground } from './unavailable.js'
import { enoent, vfs, type VfsDirent, type VfsStats } from './vfs.js'

function rejects(name: string): () => Promise<never> {
  const call = notInPlayground(name, 'node:fs/promises')
  return async () => call()
}

export async function stat(p: string): Promise<VfsStats> {
  const st = vfs().stat(p)
  if (st === undefined) throw enoent('stat', p)
  return st
}

export const lstat = stat

export async function readdir(
  p: string,
  opts?: { withFileTypes?: boolean },
): Promise<VfsDirent[] | string[]> {
  const entries = vfs().list(p)
  if (entries === undefined) throw enoent('scandir', p)
  return opts?.withFileTypes === true ? entries : entries.map((e) => e.name)
}

export async function readFile(p: string, enc?: string): Promise<Uint8Array | string> {
  const bytes = vfs().read(p)
  if (bytes === undefined) throw enoent('open', p)
  return enc === undefined ? bytes : new TextDecoder().decode(bytes)
}

export async function realpath(p: string): Promise<string> {
  if (vfs().stat(p) === undefined) throw enoent('realpath', p)
  return p
}

export const writeFile = rejects('writeFile')
export const mkdir = rejects('mkdir')
export const rm = rejects('rm')
export const rmdir = rejects('rmdir')
export const rename = rejects('rename')
export const unlink = rejects('unlink')
export const open = rejects('open')
export const mkdtemp = rejects('mkdtemp')
export const symlink = rejects('symlink')
export const readlink = rejects('readlink')
export const chmod = rejects('chmod')
export const utimes = rejects('utimes')
export const appendFile = rejects('appendFile')
export const access = rejects('access')
export const cp = rejects('cp')

export default { stat, lstat, readdir, readFile, realpath }
