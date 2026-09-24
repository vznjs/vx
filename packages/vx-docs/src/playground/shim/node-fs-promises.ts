// `node:fs/promises` for the playground bundle; see node-fs.ts.

import { enoent, vfs, type VfsDirent, type VfsStats } from './vfs.js'

function notInPlayground(name: string): () => Promise<never> {
  return () =>
    Promise.reject(
      new Error(
        `playground: node:fs/promises ${name} is not available (the plan should not reach it)`,
      ),
    )
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

export const writeFile = notInPlayground('writeFile')
export const mkdir = notInPlayground('mkdir')
export const rm = notInPlayground('rm')
export const rmdir = notInPlayground('rmdir')
export const rename = notInPlayground('rename')
export const unlink = notInPlayground('unlink')
export const open = notInPlayground('open')
export const mkdtemp = notInPlayground('mkdtemp')
export const symlink = notInPlayground('symlink')
export const readlink = notInPlayground('readlink')
export const chmod = notInPlayground('chmod')
export const utimes = notInPlayground('utimes')
export const appendFile = notInPlayground('appendFile')
export const access = notInPlayground('access')
export const cp = notInPlayground('cp')

export default { stat, lstat, readdir, readFile, realpath }
