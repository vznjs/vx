# `src/cli/upgrade.ts` — `vx upgrade`

## Purpose

`vx upgrade [TAG]` brings vx to a release the way it was installed. A
compiled binary installed by hand reads its platform package
(`@vzn/vx-<os>-<arch>`) from the npm registry the user configured
(`cli/registry.ts`: `.npmrc`, bunfig, npmjs.org last, with that
registry's credential sent under it only), verifies npm's registry
signature over `name@version:integrity` against npm's key pinned here,
verifies the tarball's SHA-512 against that integrity, extracts
`package/vx` and renames it over the current executable. The signature
is what proves the bytes are npm's: the host serving the tarball cannot
make it (2026-10-13; pnpm/get checks the same). A vx a package
manager installed is upgraded by that manager (`managedInstall`,
`upgradeArgv`); vx never installs Node or a package manager.

Handed off by a global vx (`VX_HANDED_OFF` names it), the project's vx
moves both to one version: its own install first, then the global
(`upgradeGlobal`), each its own way; a refusal names the install that
failed (2026-10-15). `vx upgrade -g` moves only the global: the
compiled binary and npm-launcher.sh skip the hand-off for it
(`upgradesOnlyItself`), and `upgradeOnlyGlobal` upgrades this vx its
own way, refusing when it is a project's install (2026-10-16).

## Public surface

```ts
export const NPM_SIGNING_KEY: SigningKey // npm's registry key, pinned
export interface SigningKey {
  id: string // npm's key id, `SHA256:…`
  spki: string // SPKI DER, base64
}
export function isBunfsPath(p: string): boolean // a path inside the compiled binary's bundle
export function isCompiledBinary(): boolean
export function npmOwnedBinary(execPath: string): string | null // the package that owns this file, or null
export function versionSpec(tag: string | undefined): string // `latest`, or the version a tag names
export async function fetchManifest(
  pkg: string,
  spec: string,
  verb?: string,
  registry?: Registry,
): Promise<unknown> // the registry's document
export interface SignedRelease {
  version: string
  tarball: string
  integrity: string // `sha512-…`, as npm signed it
}
// refuses no signature, an unpinned key id, a signature that does not verify, no integrity
export function verifiedRelease(manifest: unknown, pkg: string, key?: SigningKey): SignedRelease

export function binaryFromTarball(tgz: Uint8Array): Uint8Array // `package/vx`
// the signature, the download's SHA-512, then the extraction; null when the release is this vx's version
export async function releaseBinary(
  pkg: string,
  spec: string,
  announce: (version: string) => void,
  key?: SigningKey,
  current?: string, // the version being replaced; default this vx's
): Promise<Uint8Array | null>
export async function replaceBinary(
  dest: string,
  fetchBinary: () => Promise<Uint8Array | null>, // runs after the write check
  starts?: (dest: string) => boolean, // false puts the previous binary back (item 1097)
): Promise<boolean> // false: nothing to install
export interface ManagedInstall {
  manager: 'npm' | 'pnpm' | 'bun' | 'yarn'
  scope: 'global' | 'project'
  cwd: string
  field?: 'dependencies' | 'devDependencies' | 'optionalDependencies'
  plugins?: string[] // the @vzn/vx-* plugins the same package.json lists from the registry
}
export function managedInstall(execPath: string, cwd: string): ManagedInstall | null
// the version `tag` names, else the registry's latest; `vx init` asks it too (verb prefixes refusals)
export async function targetVersion(tag: string | undefined, verb?: string): Promise<string>
export function upgradeArgv(install: ManagedInstall, version: string): string[] // core and plugins pinned to `version`, one install
// runs that argv; a plugin behind `version` runs it even when core is at it
export async function upgradeManaged(
  install: ManagedInstall,
  version: string,
  current?: string,
  step?: string,
): Promise<void>
// the global vx at `from` to `version`: replaced, or updated by its manager; refusals name it
export async function upgradeGlobal(from: string, version: string, key?: SigningKey): Promise<void>
// `vx upgrade -g`: this vx alone to `version`; a project's install refuses
export async function upgradeOnlyGlobal(
  self: string,
  version: string,
  current?: string,
): Promise<void>
export async function upgradeCmd(argv: readonly string[]): Promise<number>
// `bin --version` when it answers as vx within the bound, else null: what `starts` asks
export function startedVersion(bin: string, timeoutMs?: number): string | null // default 10 s
```

A host the box cannot reach is one line naming the host and the step
(`could not reach <host> to <what>`), never Bun's `fetch` stack
(832c349).

## Invariants

- Every refusal (signature, key id, integrity, extraction, a directory
  it cannot write) comes before anything is written; the tarball is not
  fetched until the signature verifies. `tests/upgrade.test.ts` holds a
  forged signature, a wrong key id, a re-signed-elsewhere integrity and a
  tampered tarball, each against an untouched `dest`.
- The signed message is built from the package vx asked for, so npm's
  signature for another package does not verify.
- No fallback to GitHub's release digest: it comes from the same host as
  the asset, so it proves the transfer only (item 1096).
- Compiled-binary detection keys off `Bun.main` / `process.argv[1]`
  (`/$bunfs/…`); `import.meta.path` is only a last fallback, since under
  `--minify --bytecode` it reports the original source path.
- A binary under `node_modules` is a package manager's: global trees by
  path (`<prefix>/lib/node_modules`, `pnpm/global`, `.bun/install/global`,
  `yarn/global`), a project by the package.json that lists `@vzn/vx`
  (the tree's root, else the nearest above cwd), its manager by lockfile,
  then `packageManager`. A `bunx` cache is refused.
- Core and every `@vzn/vx-*` plugin beside it move in one install to one
  release (2026-10-16); a plugin in another field is refused before
  anything runs.
- The compiled path against the real registry stays manual (proven
  2026-10-13: `@vzn/vx-<os>-<arch>@0.0.635` for all four targets verified,
  extracted, and the linux-x64 binary answered `vx 0.0.635`).
