// The in-memory workspace the planner reads instead of a disk: absolute
// posix path → bytes, directories implied by the files under them. One VFS
// is active at a time (`useVfs`); the `node:fs` / `node:fs/promises` /
// `Bun.file` shims all read it. Every read is counted, so a harness can
// show the plan reached the files through here and nowhere else.

export interface VfsStats {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
}

export interface VfsDirent {
  name: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

function normalize(p: string): string {
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return `/${parts.join('/')}`
}

export class Vfs {
  readonly files = new Map<string, Uint8Array>()
  readonly dirs = new Set<string>(['/'])
  readonly reads: string[] = []

  constructor(root: string, files: Record<string, string | Uint8Array>) {
    const enc = new TextEncoder()
    for (const [rel, body] of Object.entries(files)) {
      const abs = normalize(`${root}/${rel}`)
      this.files.set(abs, typeof body === 'string' ? enc.encode(body) : body)
      let dir = abs.slice(0, abs.lastIndexOf('/')) || '/'
      while (!this.dirs.has(dir)) {
        this.dirs.add(dir)
        dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
      }
    }
  }

  read(p: string): Uint8Array | undefined {
    const abs = normalize(p)
    this.reads.push(abs)
    return this.files.get(abs)
  }

  stat(p: string): VfsStats | undefined {
    const abs = normalize(p)
    const file = this.files.get(abs)
    if (file === undefined && !this.dirs.has(abs)) return undefined
    return {
      isFile: () => file !== undefined,
      isDirectory: () => file === undefined,
      isSymbolicLink: () => false,
      size: file?.byteLength ?? 0,
      mtimeMs: 0,
      ctimeMs: 0,
      ino: 0,
    }
  }

  list(p: string): VfsDirent[] | undefined {
    const abs = normalize(p)
    if (!this.dirs.has(abs)) return undefined
    const prefix = abs === '/' ? '/' : `${abs}/`
    const names = new Map<string, boolean>()
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue
      const rest = f.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) names.set(rest, true)
      else names.set(rest.slice(0, slash), false)
    }
    return [...names].map(([name, isFile]) => ({
      name,
      isFile: () => isFile,
      isDirectory: () => !isFile,
      isSymbolicLink: () => false,
    }))
  }
}

let active: Vfs | null = null

export function useVfs(vfs: Vfs): void {
  active = vfs
}

export function vfs(): Vfs {
  if (active === null) throw new Error('playground: no virtual file system is active')
  return active
}

export function enoent(syscall: string, p: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`), {
    code: 'ENOENT',
    syscall,
    path: p,
  })
}
