// `fingerprint`: a lockfile of another ecosystem. Python's `uv.lock`,
// claimed through core's `lockfileClaim`: each workspace member keys on
// its own dependency closure, so a bump only `api` reaches moves only
// `api`'s keys, and `vx run --affected` selects only `api`. Core keeps the
// memo, the per-run gate and the `--affected` diff; this is the parser.
import { definePlugin, lockfileClaim, reachDigests, type VxPlugin } from '@vzn/vx'

export function uv(): VxPlugin {
  const claim = lockfileClaim({ file: 'uv.lock', version: 1, digest: uvDigests })
  return definePlugin(import.meta, { fingerprint: claim.fingerprint, key: claim.key })
}

type Requirement = { readonly name: string }

interface UvPackage {
  readonly name: string
  readonly version?: string
  /** A member's `{ editable = "packages/api" }`, or the root's `{ virtual = "." }`. */
  readonly source?: Readonly<Record<string, unknown>>
  readonly dependencies?: readonly Requirement[]
  readonly 'optional-dependencies'?: Readonly<Record<string, readonly Requirement[]>>
  readonly 'dev-dependencies'?: Readonly<Record<string, readonly Requirement[]>>
  readonly sdist?: { readonly hash?: string }
}

/** Each member directory's digest: everything it reaches in `uv.lock`. */
function uvDigests(text: string): Map<string, string> {
  const packages = (Bun.TOML.parse(text) as { package?: UvPackage[] }).package ?? []
  const index = new Map(packages.map((p, i) => [p.name, i]))
  const requires = (p: UvPackage): Requirement[] => [
    ...(p.dependencies ?? []),
    ...Object.values(p['optional-dependencies'] ?? {}).flat(),
    ...Object.values(p['dev-dependencies'] ?? {}).flat(),
  ]
  const digests = reachDigests({
    material: packages.map((p) => `${p.name}@${p.version ?? ''}#${p.sdist?.hash ?? ''}`),
    edges: packages.map((p) => requires(p).flatMap((r) => index.get(r.name) ?? [])),
  })
  const members = new Map<string, string>()
  packages.forEach((p, i) => {
    const dir = p.source?.['editable'] ?? p.source?.['virtual']
    if (typeof dir === 'string') members.set(dir.replace(/^\.\/?/, '') || '.', digests[i]!)
  })
  return members
}
