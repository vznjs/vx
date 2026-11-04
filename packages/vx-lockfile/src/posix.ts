/**
 * `packages/a` + `../b` → `packages/b`; `.` + `packages/a` → `packages/a`.
 * POSIX, as lockfiles write paths. Undefined for a path above the root: it
 * dropped each `..` past it, so `link:../ext` from the root named `ext`.
 */
export function joinPosix(base: string, rel: string): string | undefined {
  const parts: string[] = []
  for (const seg of `${base}/${rel}`.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg !== '..') parts.push(seg)
    else if (parts.pop() === undefined) return undefined
  }
  return parts.length === 0 ? '.' : parts.join('/')
}

/**
 * `joinPosix`, but a path above the root keeps its leading `..`
 * (`packages/a` + `../../../ext` → `../ext`): a local directory dependency
 * beside the repository, whose content the claim hashes.
 */
export function resolvePosix(base: string, rel: string): string {
  const parts: string[] = []
  for (const seg of `${base}/${rel}`.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..' && parts.length > 0 && parts.at(-1) !== '..') parts.pop()
    else parts.push(seg)
  }
  return parts.length === 0 ? '.' : parts.join('/')
}
