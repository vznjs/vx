#!/usr/bin/env bun
// THIRD_PARTY_NOTICES.txt: what the compiled vx binary embeds besides vx —
// the Bun runtime and the npm packages the bundler pulls in — with each
// license text. The platform packages ship it beside the binary: MIT,
// BSD and Apache-2.0 each require their notice in every copy, and Bun's
// own license names the LGPL JavaScriptCore it links statically.
//
// The npm part is derived from the bundle's own inputs, so a dependency
// that joins or leaves the binary changes the file, and
// tests/third-party-notices.unsafe.test.ts fails until it is regenerated:
//
//   bun packages/vx/scripts/third-party-notices.ts
//
// Bun's license is fetched for the Bun the release compiles with (the root
// `packageManager` pin) only when that pin moves; otherwise the committed
// copy is kept, so a regenerate needs no network.

import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const CORE = resolve(import.meta.dir, '..')
const ROOT = resolve(CORE, '..', '..')
export const NOTICES = join(CORE, 'THIRD_PARTY_NOTICES.txt')
const RULE = '='.repeat(72)

/** A dual-licensed package is distributed under the license named here. */
const ELECTED: Record<string, string> = { 'node-forge': 'BSD-3-Clause' }

/** The Bun every release binary is compiled with. */
export function pinnedBun(): string {
  const pm: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).packageManager
  const m = /^bun@(\d+\.\d+\.\d+)$/.exec(pm)
  if (!m) throw new Error(`root packageManager is not an exact bun pin: ${pm}`)
  return m[1]!
}

/** The npm packages `src/bin.ts` bundles, as their real directories, sorted by name. */
async function bundledPackages(): Promise<
  { name: string; version: string; license: string; text: string }[]
> {
  const r = await Bun.build({
    entrypoints: [join(CORE, 'src', 'bin.ts')],
    target: 'bun',
    metafile: true,
  })
  if (!r.success) throw new AggregateError(r.logs, 'bundling src/bin.ts failed')
  const dirs = new Set<string>()
  for (const input of Object.keys(r.metafile!.inputs)) {
    const m = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(resolve(input))
    if (m) dirs.add(realpathSync(m[1]!))
  }
  const out = []
  for (const dir of dirs) {
    const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const files = readdirSync(dir)
      .filter((f) => /^(licen[cs]e|copying|notice)/i.test(f))
      .sort()
    if (!files.some((f) => !/^notice/i.test(f))) throw new Error(`${pj.name}: no license file`)
    let license: string = pj.license
    if (/ OR /.test(license)) {
      const pick = ELECTED[pj.name]
      if (!pick) throw new Error(`${pj.name} is ${license}: name the license vx uses in ELECTED`)
      license = `${license}, used under ${pick}`
    }
    const text = files.map((f) => readFileSync(join(dir, f), 'utf8').trimEnd()).join('\n\n')
    out.push({ name: pj.name, version: pj.version, license, text })
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1))
}

function section(title: string, body: string): string {
  return `${RULE}\n${title}\n${RULE}\n\n${body}\n`
}

const bunTitle = (v: string) =>
  `Bun v${v} (https://github.com/oven-sh/bun/blob/bun-v${v}/LICENSE.md)`

/** The Bun license text a notices file carries, when it is for Bun `version`. */
export function committedBunLicense(notices: string, version: string): string | undefined {
  const head = `${RULE}\n${bunTitle(version)}\n${RULE}\n\n`
  const at = notices.indexOf(head)
  if (at < 0) return undefined
  const end = notices.indexOf(`\n${RULE}\n`, at + head.length)
  return notices.slice(at + head.length, end < 0 ? undefined : end).trimEnd()
}

export async function renderNotices(bunVersion: string, bunLicense: string): Promise<string> {
  const pkgs = await bundledPackages()
  return [
    'Third-party notices for the vx binary\n\n' +
      'The vx binary (the @vzn/vx-<platform> npm packages and the GitHub release\n' +
      'assets) is vx compiled with Bun. It embeds the Bun runtime and the npm\n' +
      'packages below; their licenses follow. vx itself is MIT (LICENSE).\n\n' +
      `Bun v${bunVersion}\n` +
      pkgs.map((p) => `${p.name}@${p.version} (${p.license})\n`).join(''),
    section(bunTitle(bunVersion), bunLicense.trimEnd()),
    ...pkgs.map((p) => section(`${p.name}@${p.version} (${p.license})`, p.text)),
  ].join('\n')
}

if (import.meta.main) {
  const version = pinnedBun()
  let bunLicense = committedBunLicense(
    await Bun.file(NOTICES)
      .text()
      .catch(() => ''),
    version,
  )
  if (bunLicense === undefined) {
    const url = `https://raw.githubusercontent.com/oven-sh/bun/bun-v${version}/LICENSE.md`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
    bunLicense = await res.text()
  }
  await Bun.write(NOTICES, await renderNotices(version, bunLicense))
  process.stdout.write(`wrote ${relative(ROOT, NOTICES)}\n`)
}
