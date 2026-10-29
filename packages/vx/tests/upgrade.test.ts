// vx upgrade — self-update mechanics. The registry, the tarball and the
// signature are driven through a stubbed `fetch` and a test signing key;
// the CLI path pins the source-mode refusal (the compiled-binary path
// needs a real release and stays manual).

import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import {
  binaryFromTarball,
  fetchManifest,
  isBunfsPath,
  managedInstall,
  NPM_SIGNING_KEY,
  npmOwnedBinary,
  relock,
  releaseBinary,
  replaceBinary,
  startedVersion,
  upgradeArgv,
  upgradeCmd,
  upgradeGlobal,
  upgradeManaged,
  upgradeOnlyGlobal,
  verifiedRelease,
  versionSpec,
  type SigningKey,
} from '../src/cli/upgrade.js'
import { UserError } from '../src/util/index.js'
import { noticed } from './helpers/notice.js'

const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-upgrade-'))
const FAKE = '#!/bin/sh\necho fake-vx\n'
const fake = (): Promise<Uint8Array> => Promise.resolve(new TextEncoder().encode(FAKE))

// The stubs answer npmjs.org; a developer's own .npmrc must not move them.
const ownRegistry = process.env['npm_config_registry']
process.env['npm_config_registry'] = 'https://registry.npmjs.org/'

afterAll(async () => {
  if (ownRegistry === undefined) delete process.env['npm_config_registry']
  else process.env['npm_config_registry'] = ownRegistry
  await rm(dir, { recursive: true, force: true })
})

/** What `fetch` answers, by URL; anything else is a 404. Counts each URL asked. */
async function withFetch<T>(
  routes: Record<string, () => Response>,
  body: (asked: string[]) => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch
  const asked: string[] = []
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    asked.push(url)
    return Promise.resolve(routes[url]?.() ?? new Response('nope', { status: 404 }))
  }) as unknown as typeof fetch
  try {
    return await body(asked)
  } finally {
    globalThis.fetch = real
  }
}

/** A gzip'd ustar holding `files`, as npm packs a package. */
function tarball(files: Record<string, string | Uint8Array>): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const [name, content] of Object.entries(files)) {
    const body = typeof content === 'string' ? new TextEncoder().encode(content) : content
    const head = new Uint8Array(512)
    const put = (at: number, text: string): void => head.set(new TextEncoder().encode(text), at)
    put(0, name)
    put(100, '0000755\0')
    put(108, '0000000\0')
    put(116, '0000000\0')
    put(124, `${body.length.toString(8).padStart(11, '0')}\0`)
    put(136, '00000000000\0')
    put(148, '        ')
    put(156, '0')
    put(257, 'ustar\0')
    put(263, '00')
    const sum = head.reduce((a, b) => a + b, 0)
    put(148, `${sum.toString(8).padStart(6, '0')}\0 `)
    blocks.push(head, body, new Uint8Array((512 - (body.length % 512)) % 512))
  }
  blocks.push(new Uint8Array(1024))
  return Bun.gzipSync(Buffer.concat(blocks))
}

const integrityOf = (bytes: Uint8Array): string =>
  `sha512-${new Bun.CryptoHasher('sha512').update(bytes).digest('base64')}`

// A key of the test's own, standing in for npm's: rows that must verify
// sign with it and pass it as the pinned key; a forgery signs with it and
// is checked against the real pin.
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const TEST_KEY: SigningKey = {
  id: 'SHA256:test-key',
  spki: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
}
const signed = (message: string): string =>
  sign('sha256', Buffer.from(message), pair.privateKey).toString('base64')

const PKG = '@vzn/vx-linux-x64'
const TARBALL_URL = `https://registry.npmjs.org/${PKG}/-/vx-linux-x64-9.9.9.tgz`
const MANIFEST_URL = `https://registry.npmjs.org/${PKG}/9.9.9`
const TGZ = tarball({ 'package/package.json': '{}', 'package/vx': FAKE })

/** The registry's document for 9.9.9, signed by `TEST_KEY` unless told otherwise. */
function manifest(
  over: { integrity?: string; signatures?: unknown; keyid?: string } = {},
): unknown {
  const integrity = integrityOf(TGZ)
  return {
    name: PKG,
    version: '9.9.9',
    dist: {
      tarball: TARBALL_URL,
      integrity: over.integrity ?? integrity,
      signatures: over.signatures ?? [
        { keyid: over.keyid ?? TEST_KEY.id, sig: signed(`${PKG}@9.9.9:${integrity}`) },
      ],
    },
  }
}

/** `releaseBinary` into a fresh `dest` against `doc` and `tgz`: the refusal (or 'installed'), what was fetched, and what `dest` holds. */
async function upgradeAgainst(
  doc: unknown,
  key: SigningKey,
  tgz: Uint8Array = TGZ,
): Promise<{ outcome: string; asked: string[]; dest: string; left: string[] }> {
  const sub = mkdtempSync(path.join(dir, 'up-'))
  const dest = path.join(sub, 'vx')
  await writeFile(dest, 'old')
  return await withFetch(
    {
      [MANIFEST_URL]: () => Response.json(doc),
      [TARBALL_URL]: () => new Response(tgz),
    },
    async (asked) => {
      const outcome = await replaceBinary(dest, () =>
        releaseBinary(PKG, '9.9.9', () => {}, key),
      ).then(
        () => 'installed',
        (err: Error) => err.message,
      )
      return { outcome, asked, dest: await readFile(dest, 'utf8'), left: await readdir(sub) }
    },
  )
}

describe('isBunfsPath', () => {
  it('matches the bunfs virtual-root marker', () => {
    expect(isBunfsPath('/$bunfs/root/vx')).toBe(true)
  })

  it('rejects real source paths — the source-mode signal', () => {
    // Under `--minify --bytecode`, import.meta.path is the SOURCE path;
    // keying compiled-binary detection off it (the old bug) misread
    // every installed release binary as "running from source".
    expect(isBunfsPath('/Users/me/vx/src/bin.ts')).toBe(false)
    expect(isBunfsPath('/private/tmp/probe.ts')).toBe(false)
    expect(isBunfsPath('')).toBe(false)
  })
})

describe('replaceBinary', () => {
  it('replaces the destination atomically, executable', async () => {
    const dest = path.join(dir, 'vx')
    await Bun.write(dest, 'old')
    expect(await replaceBinary(dest, fake)).toBe(true)
    expect(await readFile(dest, 'utf8')).toContain('fake-vx')
    expect((await stat(dest)).mode & 0o111).not.toBe(0)
  })

  it('nothing to install replaces nothing', async () => {
    const dest = path.join(dir, 'vx-same')
    await Bun.write(dest, 'old')
    expect(await replaceBinary(dest, () => Promise.resolve(null))).toBe(false)
    expect(await readFile(dest, 'utf8')).toBe('old')
  })

  it('stages in a fresh directory: a link planted at a guessable name is never written through', async () => {
    // Whoever can write the install directory could plant `vx.upgrade-<pid>`
    // pointing at a root-owned file, and `sudo vx upgrade` wrote the release
    // through it. The names a pid predicts now hold only the planted links.
    const victim = path.join(dir, 'victim')
    await writeFile(victim, 'untouched')
    const dest = path.join(dir, 'vx-plant')
    await writeFile(dest, 'old')
    for (const name of [`vx-plant.upgrade-${process.pid}`, `vx-plant.previous-${process.pid}`]) {
      await symlink(victim, path.join(dir, name))
    }
    await replaceBinary(dest, fake, () => true)
    // CONTROL: the upgrade went through, so the victim held because nothing
    // wrote through the links, not because nothing was written.
    expect(await readFile(dest, 'utf8')).toContain('fake-vx')
    expect(await readFile(victim, 'utf8')).toBe('untouched')
    expect(
      await Array.fromAsync(
        new Bun.Glob('.vx-upgrade-*').scan({ cwd: dir, dot: true, onlyFiles: false }),
      ),
    ).toEqual([])
  })

  it('an empty binary is refused', async () => {
    const dest = path.join(dir, 'vx4')
    await Bun.write(dest, 'old')
    await expect(replaceBinary(dest, () => Promise.resolve(new Uint8Array()))).rejects.toThrow(
      "vx upgrade: the release's binary is empty — nothing replaced",
    )
    expect(await readFile(dest, 'utf8')).toBe('old')
  })

  // Item 1097: the install's own mode was replaced with 0755.
  it("keeps the replaced binary's mode", async () => {
    const dest = path.join(dir, 'vx-mode')
    await Bun.write(dest, 'old')
    await chmod(dest, 0o750)
    await replaceBinary(dest, fake)
    expect(await readFile(dest, 'utf8')).toContain('fake-vx')
    expect((await stat(dest)).mode & 0o7777).toBe(0o750)
  })

  // Item 1097: a binary this machine cannot start was reported installed,
  // with the old one gone.
  it('puts the previous binary back when the new one does not start, and leaves nothing', async () => {
    const sub = path.join(dir, 'roll')
    await mkdir(sub)
    const dest = path.join(sub, 'vx')
    await Bun.write(dest, 'old')
    let asked = ''
    let caught: unknown
    try {
      await replaceBinary(dest, fake, (bin) => {
        asked = readFileSync(bin, 'utf8')
        return false
      })
    } catch (err) {
      caught = err
    }
    // The new bytes were what it asked about; the old ones are back.
    expect(asked).toContain('fake-vx')
    expect(caught).toBeInstanceOf(UserError)
    expect((caught as Error).message).toContain('the previous vx is back in place')
    expect(await readFile(dest, 'utf8')).toBe('old')
    expect(await readdir(sub)).toEqual(['vx'])
    // CONTROL: one that starts keeps the new bytes, and no spare name.
    await replaceBinary(dest, fake, () => true)
    expect(await readFile(dest, 'utf8')).toContain('fake-vx')
    expect(await readdir(sub)).toEqual(['vx'])
  })

  it('a rename that fails is one refusal naming dest, and leaves no temp file', async () => {
    // A non-empty directory at dest: the write and chmod of the temp file
    // succeed, the rename over dest does not.
    const dest = path.join(dir, 'vx6')
    await mkdir(path.join(dest, 'inside'), { recursive: true })
    let caught: unknown
    try {
      await replaceBinary(dest, fake)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UserError)
    const message = (caught as Error).message
    expect(message.startsWith(`vx upgrade: could not replace ${dest} (`)).toBe(true)
    expect(
      message.endsWith(`) — nothing replaced; check the permissions of ${dest} and its directory`),
    ).toBe(true)
    expect(
      await Array.fromAsync(
        new Bun.Glob('.vx-upgrade-*').scan({ cwd: dir, dot: true, onlyFiles: false }),
      ),
    ).toEqual([])
    expect(await readdir(dest)).toEqual(['inside'])
  })
})

describe('a release from the npm registry', () => {
  it('installs when npm’s signature and the integrity verify (control)', async () => {
    const r = await upgradeAgainst(manifest(), TEST_KEY)
    expect(r).toEqual({
      outcome: 'installed',
      asked: [MANIFEST_URL, TARBALL_URL],
      dest: FAKE,
      left: ['vx'],
    })
  })

  it('a configured mirror serves the release with its token; another host gets none', async () => {
    const mirror = 'https://npm.corp.example/api/npm/'
    const rc = path.join(mkdtempSync(path.join(dir, 'rc-')), '.npmrc')
    await writeFile(rc, `//npm.corp.example/api/npm/:_authToken=\${CORP_TOKEN}\n`)
    const tarballs = { mirror: `${mirror}${PKG}/-/vx-linux-x64-9.9.9.tgz`, other: TARBALL_URL }
    const env = {
      npm_config_registry: process.env['npm_config_registry'],
      npm_config_userconfig: process.env['npm_config_userconfig'],
      CORP_TOKEN: process.env['CORP_TOKEN'],
    }
    process.env['npm_config_registry'] = mirror
    process.env['npm_config_userconfig'] = rc
    process.env['CORP_TOKEN'] = 's3cret'
    const real = globalThis.fetch
    try {
      for (const tarballAt of Object.values(tarballs)) {
        const asked: [string, string | null][] = []
        const integrity = integrityOf(TGZ)
        const doc = {
          version: '9.9.9',
          dist: {
            tarball: tarballAt,
            integrity,
            signatures: [{ keyid: TEST_KEY.id, sig: signed(`${PKG}@9.9.9:${integrity}`) }],
          },
        }
        globalThis.fetch = ((input: string, init?: RequestInit) => {
          asked.push([input, new Headers(init?.headers).get('authorization')])
          if (input === `${mirror}${PKG}/9.9.9`) return Promise.resolve(Response.json(doc))
          if (input === tarballAt) return Promise.resolve(new Response(TGZ))
          return Promise.resolve(new Response('nope', { status: 404 }))
        }) as unknown as typeof fetch
        await releaseBinary(PKG, '9.9.9', () => {}, TEST_KEY)
        expect(asked).toEqual([
          [`${mirror}${PKG}/9.9.9`, 'Bearer s3cret'],
          [tarballAt, tarballAt === tarballs.mirror ? 'Bearer s3cret' : null],
        ])
      }
    } finally {
      globalThis.fetch = real
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('a forged signature is refused before the tarball is fetched', async () => {
    // Signed by a key that is not npm's, under npm's key id.
    const r = await upgradeAgainst(manifest({ keyid: NPM_SIGNING_KEY.id }), NPM_SIGNING_KEY)
    expect(r).toEqual({
      outcome: `vx upgrade: the npm registry signature for ${PKG}@9.9.9 is not valid — refusing to install; nothing replaced`,
      asked: [MANIFEST_URL],
      dest: 'old',
      left: ['vx'],
    })
  })

  it('a key id it does not pin is refused with the installer hint', async () => {
    const r = await upgradeAgainst(manifest({ keyid: 'SHA256:rotated' }), TEST_KEY)
    expect(r.outcome).toBe(
      `vx upgrade: ${PKG}@9.9.9 is signed with an npm key this vx does not know (SHA256:rotated) — if npm rotated its signing key, this vx's installer needs updating: install the new release with bun add -g @vzn/vx@latest, or from https://github.com/vznjs/vx/releases. Nothing replaced`,
    )
    expect([r.asked, r.dest, r.left]).toEqual([[MANIFEST_URL], 'old', ['vx']])
  })

  it('an integrity other than the one npm signed is refused before the tarball is fetched', async () => {
    // The tarball and the document agree, the signature does not: whoever
    // swapped both could not sign the new integrity.
    const other = tarball({ 'package/vx': '#!/bin/sh\necho evil\n' })
    const r = await upgradeAgainst(manifest({ integrity: integrityOf(other) }), TEST_KEY, other)
    expect(r).toEqual({
      outcome: `vx upgrade: the npm registry signature for ${PKG}@9.9.9 is not valid — refusing to install; nothing replaced`,
      asked: [MANIFEST_URL],
      dest: 'old',
      left: ['vx'],
    })
  })

  it('a tampered tarball is refused before anything is written', async () => {
    const tampered = tarball({
      'package/package.json': '{}',
      'package/vx': '#!/bin/sh\necho evil\n',
    })
    const r = await upgradeAgainst(manifest(), TEST_KEY, tampered)
    expect(r.outcome).toBe(
      `vx upgrade: the download did not match the integrity npm signed (expected ${integrityOf(TGZ)}, got ${integrityOf(tampered)}) — nothing replaced; try again, and if it repeats the tarball is not the one npm published`,
    )
    expect([r.asked, r.dest, r.left]).toEqual([[MANIFEST_URL, TARBALL_URL], 'old', ['vx']])
  })

  it('no signature, or no integrity, is refused before the tarball is fetched', async () => {
    expect((await upgradeAgainst(manifest({ signatures: [] }), TEST_KEY)).outcome).toBe(
      `vx upgrade: ${PKG}@9.9.9 carries no npm registry signature, so it cannot be verified — nothing replaced`,
    )
    const bare = manifest() as { dist: { integrity?: string } }
    delete bare.dist.integrity
    expect((await upgradeAgainst(bare, TEST_KEY)).outcome).toBe(
      `vx upgrade: the npm registry published no SHA-512 integrity for ${PKG}@9.9.9 — nothing to verify the download against, so it is not attempted`,
    )
  })

  it('a signature for another package does not verify for this one', () => {
    const doc = manifest() as { dist: { signatures: { keyid: string; sig: string }[] } }
    doc.dist.signatures = [
      { keyid: TEST_KEY.id, sig: signed(`@vzn/vx-darwin-arm64@9.9.9:${integrityOf(TGZ)}`) },
    ]
    expect(() => verifiedRelease(doc, PKG, TEST_KEY)).toThrow(/signature .* is not valid/)
  })

  it('pins npm’s current registry key', () => {
    // https://registry.npmjs.org/-/npm/v1/keys, the key with no expiry.
    expect(NPM_SIGNING_KEY.id).toBe('SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U')
  })

  it('this vx’s own version downloads nothing', async () => {
    const { VERSION } = await import('../src/version.js')
    const integrity = integrityOf(TGZ)
    const doc = {
      version: VERSION,
      dist: {
        tarball: TARBALL_URL,
        integrity,
        signatures: [{ keyid: TEST_KEY.id, sig: signed(`${PKG}@${VERSION}:${integrity}`) }],
      },
    }
    const result = await withFetch({ [MANIFEST_URL]: () => Response.json(doc) }, async (asked) => [
      await releaseBinary(PKG, '9.9.9', () => {}, TEST_KEY),
      asked,
    ])
    expect(result).toEqual([null, [MANIFEST_URL]])
  })

  it('a host it cannot reach is one line naming the host, never a stack', async () => {
    const real = globalThis.fetch
    globalThis.fetch = (() =>
      Promise.reject(
        new TypeError('Unable to connect. Is the computer able to access the url?'),
      )) as unknown as typeof fetch
    try {
      await expect(fetchManifest(PKG, 'latest')).rejects.toThrow(
        'vx upgrade: could not reach registry.npmjs.org to read the release (Unable to connect. Is the computer able to access the url?) — check the network or the proxy and re-run',
      )
    } finally {
      globalThis.fetch = real
    }
  })

  it('a registry document that is not JSON is one refusal naming the host, never a stack', async () => {
    // A captive portal or a proxy's error page served with a 200.
    const message = await withFetch(
      { [`https://registry.npmjs.org/${PKG}/latest`]: () => new Response('<html>sign in</html>') },
      () =>
        fetchManifest(PKG, 'latest').then(
          () => 'resolved',
          (err: Error) => err.message,
        ),
    )
    expect(
      message.startsWith('vx upgrade: could not read the release from registry.npmjs.org ('),
    ).toBe(true)
    expect(
      message.endsWith(') — nothing replaced; check the network or the proxy and re-run'),
    ).toBe(true)
  })

  it('a version the registry does not have says so', async () => {
    const message = await withFetch({}, () =>
      fetchManifest(PKG, '9.9.8').then(
        () => 'resolved',
        (err: Error) => err.message,
      ),
    )
    expect(message).toBe(
      `vx upgrade: could not read ${PKG}@9.9.8 from registry.npmjs.org (404) — is 9.9.8 a published version?`,
    )
  })

  it('a transfer cut after the headers is one refusal, never a stack, and replaces nothing', async () => {
    const reset = Object.assign(new TypeError('The socket connection was closed unexpectedly.'), {
      code: 'ECONNRESET',
    })
    const cut = (): Response =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode('x'.repeat(1000)))
            controller.error(reset)
          },
        }),
      )
    const sub = mkdtempSync(path.join(dir, 'cut-'))
    const dest = path.join(sub, 'vx')
    await writeFile(dest, 'old')
    const message = await withFetch(
      { [MANIFEST_URL]: () => Response.json(manifest()), [TARBALL_URL]: cut },
      () =>
        replaceBinary(dest, () => releaseBinary(PKG, '9.9.9', () => {}, TEST_KEY)).then(
          () => 'installed',
          (err: Error) => err.message,
        ),
    )
    expect(message).toBe(
      'vx upgrade: could not download the release from registry.npmjs.org (The socket connection was closed unexpectedly.) — nothing replaced; check the network or the proxy and re-run',
    )
    expect([await readFile(dest, 'utf8'), await readdir(sub)]).toEqual(['old', ['vx']])
  })
})

describe('binaryFromTarball', () => {
  it('takes package/vx, and refuses a tarball without it or not gzip', () => {
    expect(new TextDecoder().decode(binaryFromTarball(TGZ))).toBe(FAKE)
    expect(() => binaryFromTarball(tarball({ 'package/README.md': 'hi' }))).toThrow(
      'vx upgrade: the release tarball holds no package/vx — nothing replaced',
    )
    expect(() => binaryFromTarball(new TextEncoder().encode('plain'))).toThrow(
      'vx upgrade: the release tarball is not gzip — nothing replaced',
    )
  })
})

describe('versionSpec', () => {
  it('reads a tag as a registry version, and refuses what is not one', () => {
    expect([versionSpec(undefined), versionSpec('v0.4.0'), versionSpec('0.4.0-rc.1')]).toEqual([
      'latest',
      '0.4.0',
      '0.4.0-rc.1',
    ])
    expect(() => versionSpec('../../evil')).toThrow('vx upgrade: ../../evil is not a version')
  })

  // A TAG no release has is usage, refused before anything else is asked:
  // from source it was "only the compiled binary upgrades itself", and on a
  // binary VX_E_REFUSED after the install was found.
  it('a bad TAG is usage, refused first', async () => {
    const refused = (fn: () => unknown): Promise<unknown> =>
      Promise.resolve()
        .then(fn)
        .then(
          () => 'accepted',
          (err: UserError) => ({ code: err.code, message: err.message }),
        )
    expect([
      await refused(() => versionSpec('nope')),
      await refused(() => upgradeCmd(['nope'])),
    ]).toEqual([
      {
        code: 'VX_E_USAGE',
        message: 'vx upgrade: nope is not a version (expected v<major>.<minor>.<patch>)',
      },
      {
        code: 'VX_E_USAGE',
        message: 'vx upgrade: nope is not a version (expected v<major>.<minor>.<patch>)',
      },
    ])
  })
})

describe('managedInstall', () => {
  const tree = async (files: Record<string, string>): Promise<string> => {
    const root = mkdtempSync(path.join(dir, 'tree-'))
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
      await writeFile(path.join(root, rel), body)
    }
    return root
  }
  const BIN = 'node_modules/@vzn/vx-linux-x64/vx'
  const lists = (field: string): string => JSON.stringify({ [field]: { '@vzn/vx': '^0.0.1' } })

  it('names each global install by its manager', () => {
    const home = '/home/me'
    expect(managedInstall(`/usr/local/lib/node_modules/@vzn/vx/${BIN}`, home)).toEqual({
      manager: 'npm',
      scope: 'global',
      cwd: '/usr/local/lib',
    })
    expect(
      managedInstall(
        `${home}/.local/share/pnpm/global/5/node_modules/.pnpm/@vzn+vx-linux-x64@0.0.1/${BIN}`,
        home,
      ),
    ).toEqual({ manager: 'pnpm', scope: 'global', cwd: `${home}/.local/share/pnpm/global/5` })
    expect(managedInstall(`${home}/.bun/install/global/${BIN}`, home)).toEqual({
      manager: 'bun',
      scope: 'global',
      cwd: `${home}/.bun/install/global`,
    })
    expect(managedInstall(`${home}/.config/yarn/global/${BIN}`, home)).toEqual({
      manager: 'yarn',
      scope: 'global',
      cwd: `${home}/.config/yarn/global`,
    })
  })

  it("names a project's manager by its lockfile, and the field that lists vx", async () => {
    const cases: [string, Record<string, string>, string, string][] = [
      ['pnpm', { 'pnpm-lock.yaml': '' }, 'devDependencies', 'pnpm add @vzn/vx@1.2.3 --save-dev'],
      ['bun', { 'bun.lock': '' }, 'devDependencies', 'bun add @vzn/vx@1.2.3 --dev'],
      ['yarn', { 'yarn.lock': '' }, 'dependencies', 'yarn add @vzn/vx@1.2.3'],
      [
        'npm',
        { 'package-lock.json': '{}' },
        'optionalDependencies',
        'npm install @vzn/vx@1.2.3 --save-optional',
      ],
    ]
    for (const [manager, lock, field, argv] of cases) {
      const root = await tree({ 'package.json': lists(field), ...lock })
      const install = managedInstall(path.join(root, BIN), root)
      expect(install).toEqual({ manager, scope: 'project', cwd: root, field, plugins: [] } as never)
      expect(upgradeArgv(install!, '1.2.3').join(' ')).toBe(argv)
    }
  })

  it('a hoisted workspace finds the member that lists vx from cwd; the root adds with --workspace-root', async () => {
    const root = await tree({
      'package.json': '{}',
      'pnpm-lock.yaml': '',
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      'apps/web/package.json': lists('devDependencies'),
    })
    const bin = path.join(root, 'node_modules/.pnpm/@vzn+vx-linux-x64@0.0.1', BIN)
    const member = managedInstall(bin, path.join(root, 'apps/web'))
    expect(member).toEqual({
      manager: 'pnpm',
      scope: 'project',
      cwd: path.join(root, 'apps/web'),
      field: 'devDependencies',
      plugins: [],
    })
    expect(upgradeArgv(member!, '1.2.3')).toEqual(['pnpm', 'add', '@vzn/vx@1.2.3', '--save-dev'])
    await writeFile(path.join(root, 'package.json'), lists('devDependencies'))
    expect(upgradeArgv(managedInstall(bin, root)!, '1.2.3')).toEqual([
      'pnpm',
      'add',
      '@vzn/vx@1.2.3',
      '--save-dev',
      '--workspace-root',
    ])
  })

  it("a sibling directory whose name extends the tree's is not the tree", async () => {
    // `/w/app-old` starts with `/w/app`: its package.json was taken for the
    // install, and the upgrade ran in a project that does not own this vx.
    const parent = await tree({ 'app-old/package.json': lists('devDependencies') })
    const root = path.join(parent, 'app')
    await mkdir(root, { recursive: true })
    expect(() => managedInstall(path.join(root, BIN), path.join(parent, 'app-old'))).toThrow(
      /no package\.json from .* up lists @vzn\/vx/,
    )
  })

  it('moves every @vzn/vx-* plugin the manifest lists to the same release, in one install', async () => {
    // 2026-10-16: core and a plugin on different releases is a broken
    // workspace; one `add` installs them all or none. Platform packages and
    // workspace links are no plugins to pin.
    const manifest = (deps: Record<string, string>): string =>
      JSON.stringify({ devDependencies: { '@vzn/vx': '^0.0.1', ...deps } })
    const root = await tree({
      'package.json': manifest({
        '@vzn/vx-lockfile': '^0.0.1',
        '@vzn/vx-otel': '0.0.1',
        '@vzn/vx-linux-x64': '0.0.1',
        '@vzn/vx-local': 'workspace:*',
        '@vzn/other': '1.0.0',
      }),
      'pnpm-lock.yaml': '',
    })
    const install = managedInstall(path.join(root, BIN), root)
    expect(install?.plugins).toEqual(['@vzn/vx-lockfile', '@vzn/vx-otel'])
    expect(upgradeArgv(install!, '1.2.3')).toEqual([
      'pnpm',
      'add',
      '@vzn/vx@1.2.3',
      '@vzn/vx-lockfile@1.2.3',
      '@vzn/vx-otel@1.2.3',
      '--save-dev',
    ])
    // A plugin in another field would move fields under core's flag: refused.
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        devDependencies: { '@vzn/vx': '^0.0.1' },
        dependencies: { '@vzn/vx-otel': '^0.0.1' },
      }),
    )
    expect(() => managedInstall(path.join(root, BIN), root)).toThrow(
      'vx upgrade: @vzn/vx-otel is in dependencies and @vzn/vx in devDependencies; list them in one field so one install moves them together',
    )
  })

  it('global argv per manager', () => {
    const g = (manager: 'npm' | 'pnpm' | 'bun' | 'yarn'): string =>
      upgradeArgv({ manager, scope: 'global', cwd: '/' }, '1.2.3').join(' ')
    expect([g('npm'), g('pnpm'), g('bun'), g('yarn')]).toEqual([
      'npm install -g @vzn/vx@1.2.3',
      'pnpm add -g @vzn/vx@1.2.3',
      'bun add -g @vzn/vx@1.2.3',
      'yarn global add @vzn/vx@1.2.3',
    ])
  })

  it('an npx or bunx cache is refused: nothing installed to upgrade', () => {
    expect(() => managedInstall(`/home/me/.npm/_npx/1a2b/${BIN}`, '/home/me')).toThrow(
      /runs from a package-manager cache/,
    )
    expect(() => managedInstall(`/tmp/bunx-1000-@vzn/vx@latest/${BIN}`, '/home/me')).toThrow(
      /runs from a package-manager cache/,
    )
  })

  it('the cache refusal suggests bunx, never npx', () => {
    let said = ''
    try {
      managedInstall(`/home/me/.npm/_npx/1a2b/${BIN}`, '/home/me')
    } catch (err) {
      said = (err as Error).message
    }
    expect(said).toContain('bunx @vzn/vx@latest')
    expect(said.replace(/\/_npx\//g, '')).not.toContain('npx')
  })

  it('a binary installed by hand is no package manager’s', () => {
    expect(managedInstall('/usr/local/bin/vx', '/home/me')).toBeNull()
  })
})

describe('startedVersion', () => {
  const fake = async (name: string, body: string): Promise<string> => {
    const bin = path.join(dir, name)
    await writeFile(bin, `#!/bin/sh\n${body}\n`)
    await chmod(bin, 0o755)
    return bin
  }

  it('is the version a binary answers as vx, and null for anything else', async () => {
    expect(startedVersion(await fake('ok', 'echo "vx 9.9.9"'))).toBe('vx 9.9.9')
    expect(startedVersion(await fake('failed', 'echo "vx 9.9.9"; exit 1'))).toBeNull()
    expect(startedVersion(await fake('other', 'echo "bun 1.4.2"'))).toBeNull()
  })

  it('is null for a binary the OS will not run, so the rollback can run', async () => {
    // A new binary on a noexec mount, or one without its execute bit, made
    // the spawn throw EACCES: the upgrade crashed with the new binary in
    // place and the old one never put back.
    const bin = await fake('noexec', 'echo "vx 9.9.9"')
    await chmod(bin, 0o644)
    expect([startedVersion(bin), startedVersion(dir)]).toEqual([null, null])
    const dest = await fake('noexec-dest', 'echo "vx 0.0.1"')
    await expect(
      replaceBinary(
        dest,
        () => Promise.resolve(new TextEncoder().encode('#!/bin/sh\necho "vx 0.0.2"\n')),
        () => startedVersion(path.join(dir, 'no-such-vx')) !== null,
      ),
    ).rejects.toThrow('the previous vx is back in place')
    expect(startedVersion(dest)).toBe('vx 0.0.1')
  })

  it('gives up on a binary that does not answer, so the rollback can run', async () => {
    // The answer decides the rollback, and it was unbounded: a new binary
    // that hung on start held `vx upgrade` forever with the old one never
    // put back (E-22). Six seconds of silence against a 300 ms bound.
    const hung = await fake('hung', 'exec sleep 6')
    const t0 = performance.now()
    expect(startedVersion(hung, 300)).toBeNull()
    expect(performance.now() - t0).toBeLessThan(3_000)
  }, 15_000)
})

describe('npmOwnedBinary', () => {
  it('names the platform package for an npm-installed binary (global, local, pnpm)', () => {
    expect(npmOwnedBinary('/usr/lib/node_modules/@vzn/vx/node_modules/@vzn/vx-linux-x64/vx')).toBe(
      '@vzn/vx-linux-x64',
    )
    expect(npmOwnedBinary('/home/me/app/node_modules/@vzn/vx-darwin-arm64/vx')).toBe(
      '@vzn/vx-darwin-arm64',
    )
    expect(
      npmOwnedBinary(
        '/home/me/app/node_modules/.pnpm/@vzn+vx-linux-x64@0.0.21/node_modules/@vzn/vx-linux-x64/vx',
      ),
    ).toBe('@vzn/vx-linux-x64')
    expect(npmOwnedBinary('C:\\Users\\me\\node_modules\\@vzn\\vx-linux-x64\\vx')).toBe(
      '@vzn/vx-linux-x64',
    )
  })

  it('is null for a binary npm does not own', () => {
    expect(npmOwnedBinary('/usr/local/bin/vx')).toBeNull()
    expect(npmOwnedBinary('/home/me/.vx/bin/vx')).toBeNull()
    expect(npmOwnedBinary('/$bunfs/root/vx')).toBeNull()
  })

  it('a node_modules with nothing under it still counts as npm-owned', () => {
    expect(npmOwnedBinary('/home/me/app/node_modules')).toBe('node_modules')
  })
})

describe('upgradeGlobal: the global vx that handed the run to the project', () => {
  // A global vx run inside a project hands `vx upgrade` to the project's
  // own; the global that started the run moves to the same version
  // (2026-10-15), the way it was installed.
  const HOST = `@vzn/vx-${process.platform}-${process.arch}`
  const answering = async (file: string, version: string): Promise<string> => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `#!/bin/sh\necho "vx ${version} (handed off from somewhere)"\n`)
    await chmod(file, 0o755)
    return file
  }

  it('replaces a binary installed by hand with the verified release', async () => {
    const bin = await answering(path.join(mkdtempSync(path.join(dir, 'g-')), 'vx'), '0.0.1')
    const tgz = tarball({ 'package/vx': '#!/bin/sh\necho "vx 9.9.9"\n' })
    const integrity = integrityOf(tgz)
    const url = `https://registry.npmjs.org/${HOST}/-/vx-9.9.9.tgz`
    const doc = {
      version: '9.9.9',
      dist: {
        tarball: url,
        integrity,
        signatures: [{ keyid: TEST_KEY.id, sig: signed(`${HOST}@9.9.9:${integrity}`) }],
      },
    }
    await withFetch(
      {
        [`https://registry.npmjs.org/${HOST}/9.9.9`]: () => Response.json(doc),
        [url]: () => new Response(tgz),
      },
      () => upgradeGlobal(bin, '9.9.9', TEST_KEY),
    )
    expect(startedVersion(bin)).toBe('vx 9.9.9')
  })

  it('one already at the version downloads nothing', async () => {
    const bin = await answering(path.join(mkdtempSync(path.join(dir, 'g-')), 'vx'), '9.9.9')
    const asked = await withFetch({}, async (asked) => {
      await upgradeGlobal(bin, '9.9.9', TEST_KEY)
      return asked
    })
    expect(asked).toEqual([])
  })

  it("updates a package manager's global install through that manager", async () => {
    const prefix = mkdtempSync(path.join(dir, 'g-'))
    const launcher = await answering(
      path.join(prefix, 'lib/node_modules/@vzn/vx/launcher.sh'),
      '0.0.1',
    )
    const tools = path.join(prefix, 'tools')
    const said = path.join(prefix, 'npm-said')
    await answering(path.join(tools, 'npm'), '')
    await writeFile(path.join(tools, 'npm'), `#!/bin/sh\necho "$PWD $*" > ${said}\n`)
    const PATH = process.env['PATH']
    process.env['PATH'] = `${tools}:${PATH}`
    try {
      await upgradeGlobal(launcher, '9.9.9', TEST_KEY)
    } finally {
      process.env['PATH'] = PATH
    }
    expect(await readFile(said, 'utf8')).toBe(
      `${realpathSync(path.join(prefix, 'lib'))} install -g @vzn/vx@9.9.9\n`,
    )
  })

  it('a refusal names the global vx, and one that does not start is left as it is', async () => {
    const bin = path.join(mkdtempSync(path.join(dir, 'g-')), 'vx')
    await writeFile(bin, '#!/bin/sh\nexit 1\n')
    await chmod(bin, 0o755)
    await expect(upgradeGlobal(bin, '9.9.9', TEST_KEY)).rejects.toThrow(
      `vx upgrade: global vx ${bin}: it did not answer \`--version\`, so it is left as it is`,
    )
  })
})

describe('upgradeOnlyGlobal: `vx upgrade -g` moves only the global vx', () => {
  // M (2026-10-16): "vx upgrade -g should only update global".
  it("updates a manager's global install with that manager, and touches no project", async () => {
    const prefix = mkdtempSync(path.join(dir, 'og-'))
    const bin = path.join(prefix, 'lib/node_modules/@vzn/vx-linux-x64/vx')
    await mkdir(path.dirname(bin), { recursive: true })
    await writeFile(bin, '')
    const tools = path.join(prefix, 'tools')
    const said = path.join(prefix, 'npm-said')
    await mkdir(tools)
    await writeFile(path.join(tools, 'npm'), `#!/bin/sh\necho "$PWD $*" > ${said}\n`)
    await chmod(path.join(tools, 'npm'), 0o755)
    const PATH = process.env['PATH']
    process.env['PATH'] = `${tools}:${PATH}`
    try {
      await upgradeOnlyGlobal(bin, '9.9.9', '0.0.1')
    } finally {
      process.env['PATH'] = PATH
    }
    expect(await readFile(said, 'utf8')).toBe(
      `${realpathSync(path.join(prefix, 'lib'))} install -g @vzn/vx@9.9.9\n`,
    )
  })

  it("refuses the project's own vx, naming what to run instead", async () => {
    const project = mkdtempSync(path.join(dir, 'op-'))
    await writeFile(
      path.join(project, 'package.json'),
      JSON.stringify({ devDependencies: { '@vzn/vx': '^0.0.1' } }),
    )
    const bin = path.join(project, 'node_modules/@vzn/vx-linux-x64/vx')
    await mkdir(path.dirname(bin), { recursive: true })
    await writeFile(bin, '')
    await expect(upgradeOnlyGlobal(bin, '9.9.9', '0.0.1')).rejects.toThrow(
      `vx upgrade -g: no global vx ran — ${bin} is the project's own. Install one (bun add -g @vzn/vx), or run \`vx upgrade\` to move the project's`,
    )
  })

  it('a global already at the version does nothing', async () => {
    const asked = await withFetch({}, async (asked) => {
      await upgradeOnlyGlobal(path.join(dir, 'nowhere', 'vx'), '9.9.9', '9.9.9')
      return asked
    })
    expect(asked).toEqual([])
  })
})

describe('upgradeManaged: core and its plugins move together', () => {
  /** A project at `core` with `plugin` installed at `pluginAt`, and a fake `manager` that records its argv and exits `code`. */
  const project = async (
    core: string,
    pluginAt: string,
    code = 0,
  ): Promise<{ root: string; said: string; run: () => Promise<void> }> => {
    const root = mkdtempSync(path.join(dir, 'p-'))
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ devDependencies: { '@vzn/vx': core, '@vzn/vx-otel': pluginAt } }),
    )
    for (const [pkg, version] of [
      ['@vzn/vx', core],
      ['@vzn/vx-otel', pluginAt],
    ] as const) {
      await mkdir(path.join(root, 'node_modules', pkg), { recursive: true })
      await writeFile(
        path.join(root, 'node_modules', pkg, 'package.json'),
        JSON.stringify({ version }),
      )
    }
    const tools = path.join(root, 'tools')
    const said = path.join(root, 'said')
    await mkdir(tools)
    await writeFile(path.join(tools, 'pnpm'), `#!/bin/sh\necho "$*" > ${said}\nexit ${code}\n`)
    await chmod(path.join(tools, 'pnpm'), 0o755)
    const install = {
      manager: 'pnpm' as const,
      scope: 'project' as const,
      cwd: root,
      field: 'devDependencies' as const,
      plugins: ['@vzn/vx-otel'],
    }
    const run = async (): Promise<void> => {
      const PATH = process.env['PATH']
      process.env['PATH'] = `${tools}:${PATH}`
      try {
        await upgradeManaged(install, '9.9.9', core)
      } finally {
        process.env['PATH'] = PATH
      }
    }
    return { root, said, run }
  }

  it('a core already at the release still installs a plugin left behind', async () => {
    const { said, run } = await project('9.9.9', '0.0.1')
    await run()
    expect(await readFile(said, 'utf8')).toBe('add @vzn/vx@9.9.9 @vzn/vx-otel@9.9.9 --save-dev\n')
    // Control: both at the release, nothing runs.
    const both = await project('9.9.9', '9.9.9')
    await both.run()
    expect(existsSync(both.said)).toBe(false)
  })

  it("pnpm's refusal names minimumReleaseAgeExclude with every package it pinned", async () => {
    const { run } = await project('0.0.1', '0.0.1', 1)
    await expect(run()).rejects.toThrow(
      'vx upgrade: pnpm add @vzn/vx@9.9.9 @vzn/vx-otel@9.9.9 --save-dev failed (exit 1) — vx changed nothing itself; if pnpm refused a version published within its minimumReleaseAge, list @vzn/vx, @vzn/vx-otel under minimumReleaseAgeExclude in pnpm-workspace.yaml',
    )
  })
})

describe('vx upgrade (CLI)', () => {
  it('refuses when running from source', async () => {
    // The only guard between this row and `replaceBinary(process.execPath)`
    // is `isCompiledBinary()`. Spawned on the host's own Bun, a broken guard
    // downloaded the vx release and renamed it over that Bun (item 779). So
    // the row runs a COPY of the runtime: a broken guard replaces the copy,
    // and the copy's digest fails the row.
    const runtime = path.join(dir, 'bun-copy')
    await copyFile(process.execPath, runtime)
    await chmod(runtime, 0o755)
    const before = new Bun.CryptoHasher('sha256').update(await readFile(runtime)).digest('hex')
    const proc = Bun.spawn({
      cmd: [runtime, path.join(import.meta.dir, '..', 'src', 'bin.ts'), 'upgrade'],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    const err = await new Response(proc.stderr).text()
    expect(new Bun.CryptoHasher('sha256').update(await readFile(runtime)).digest('hex')).toBe(
      before,
    )
    expect(code).toBe(1)
    expect(err).toBe(
      noticed(
        'vx upgrade: only the compiled binary upgrades itself; this vx runs from source — use git pull\n',
      ),
    )
  })

  it('refuses a second tag instead of installing the first', async () => {
    // Refused before the compiled-binary guard, so it is visible from
    // source; the copy of the runtime holds for the same reason as above.
    const runtime = path.join(dir, 'bun-copy-2')
    await copyFile(process.execPath, runtime)
    await chmod(runtime, 0o755)
    const before = new Bun.CryptoHasher('sha256').update(await readFile(runtime)).digest('hex')
    const proc = Bun.spawn({
      cmd: [runtime, path.join(import.meta.dir, '..', 'src', 'bin.ts'), 'upgrade', 'v1', 'v2'],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    const err = await new Response(proc.stderr).text()
    expect(new Bun.CryptoHasher('sha256').update(await readFile(runtime)).digest('hex')).toBe(
      before,
    )
    expect(code).toBe(1)
    expect(err).toBe(noticed('vx upgrade: unexpected argument: v2 (see `vx upgrade --help`)\n'))
  })
})

describe('vx upgrade (CLI), a tag that is no version', () => {
  it('is refused as such, before the compiled-binary guard', async () => {
    // `vx upgrade lastest` said "runs from source" (or, from npx, "runs from a
    // package-manager cache"), never that the tag was the mistake.
    const runtime = path.join(dir, 'bun-copy-3')
    await copyFile(process.execPath, runtime)
    await chmod(runtime, 0o755)
    const proc = Bun.spawn({
      cmd: [runtime, path.join(import.meta.dir, '..', 'src', 'bin.ts'), 'upgrade', 'lastest'],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    expect([code, await new Response(proc.stderr).text()]).toEqual([
      1,
      noticed('vx upgrade: lastest is not a version (expected v<major>.<minor>.<patch>)\n'),
    ])
  })
})

describe('relock', () => {
  // 2026-10-18: an upgrade locks with the new vx; a failed lock says to run it.
  const workspace = async (name: string, lock: string): Promise<{ root: string; bin: string }> => {
    const root = path.join(dir, name)
    await mkdir(path.join(root, '.vx', 'sub'), { recursive: true })
    await writeFile(path.join(root, '.vx', 'workspace.ts'), 'export default {}\n')
    const bin = path.join(root, 'vx')
    await writeFile(bin, `#!/bin/sh\necho "$1 $PWD" > "${root}/ran"\n${lock}\n`)
    await chmod(bin, 0o755)
    return { root, bin }
  }

  it("runs the new vx's lock at the workspace root", async () => {
    const { root, bin } = await workspace('relock-ok', 'exit 0')
    await relock(bin, path.join(root, '.vx', 'sub'))
    expect((await readFile(path.join(root, 'ran'), 'utf8')).trim()).toBe(
      `lock ${realpathSync(root)}`,
    )
  })

  it('a lock that fails says to run vx lock, and the upgrade stands', async () => {
    const { root, bin } = await workspace('relock-fail', 'exit 1')
    const err = spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await relock(bin, root)
      expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('run vx lock')
    } finally {
      err.mockRestore()
    }
  })

  it('a new vx that is not there says to run vx lock, and the upgrade stands', async () => {
    // An npm global install has no `<prefix>/lib/node_modules/.bin/vx`: the
    // spawn's ENOENT reached the user as a crash after a finished upgrade.
    const { root } = await workspace('relock-missing', 'exit 0')
    const err = spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await relock(path.join(root, 'node_modules', '.bin', 'vx'), root)
      expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('run vx lock')
    } finally {
      err.mockRestore()
    }
  })

  it('outside a workspace runs nothing', async () => {
    const out = path.join(dir, 'relock-none')
    await mkdir(out, { recursive: true })
    const bin = path.join(out, 'vx')
    await writeFile(bin, `#!/bin/sh\ntouch "${out}/ran"\n`)
    await chmod(bin, 0o755)
    await relock(bin, out)
    expect(existsSync(path.join(out, 'ran'))).toBe(false)
  })
})
