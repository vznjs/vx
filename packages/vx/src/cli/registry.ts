// The npm registry a package's releases are read from, as the user
// configured it for their package manager: many companies block
// registry.npmjs.org and serve a mirror. npm's order first: a scoped
// `@scope:registry` from any `.npmrc`, then `registry` from the
// environment, the `.npmrc` files from the cwd up, and the user's. Then
// bunfig's `install.scopes` / `install.registry`. npmjs.org only when
// nothing names one. The credential npm or Bun would send to that host
// goes with each request under it, never to another host.

import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { UserError } from '../util/index.js'

const NPMJS = 'https://registry.npmjs.org/'

export interface Registry {
  /** Base URL, ending in `/`. */
  url: string
  /** The `Authorization` value for a URL under the registry, if one is configured. */
  auth(url: string): string | undefined
}

type Env = Record<string, string | undefined>

/** `npm_config_<key>`, either case, as npm reads it. */
function npmEnv(env: Env, key: string): string | undefined {
  return env[`npm_config_${key}`] ?? env[`NPM_CONFIG_${key.toUpperCase()}`]
}

/** `${VAR}` from `env`, as npm expands it; an unset one is empty. */
const expandNpm = (value: string, env: Env): string =>
  value.replace(/\$\{([^}?]+)\??\}/g, (_, name: string) => env[name] ?? '')

/** `$VAR` and `${VAR}` from `env`, as Bun expands bunfig. */
const expandBun = (value: string, env: Env): string =>
  expandNpm(value, env).replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => env[name] ?? '')

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** An `.npmrc`'s `key=value` lines. */
function parseNpmrc(text: string, env: Env): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    let value = line.slice(eq + 1).trim()
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1)
    out.set(expandNpm(line.slice(0, eq).trim(), env), expandNpm(value, env))
  }
  return out
}

const withSlash = (url: string): string => (url.endsWith('/') ? url : `${url}/`)

/**
 * `value` when it is an http(s) URL. A hand-written one is a boundary: a
 * scheme left out (`registry=npm.corp.example`) crashed the request with
 * a TypeError stack.
 */
function httpUrl(value: string, where: string): string {
  let u: URL | undefined
  try {
    u = new URL(value)
  } catch {}
  if (u?.protocol !== 'https:' && u?.protocol !== 'http:') {
    throw new UserError(`registry "${value}" in ${where} is not an http(s) URL`)
  }
  return value
}

/** npm's "nerf dart": `//host[:port]/path/`, the key its credentials sit under. */
const nerfDart = (url: string): string => {
  const u = new URL(url)
  return `//${u.host}${withSlash(u.pathname)}`
}

interface Bunfig {
  registry?: unknown
  scopes?: Record<string, unknown>
}

/** A bunfig registry: a URL (credentials allowed in it), or `{ url, token }` / `{ url, username, password }`. */
function bunRegistry(
  value: unknown,
  env: Env,
  file: string,
): { url: string; auth?: string } | undefined {
  const entry =
    typeof value === 'string'
      ? { url: value }
      : typeof value === 'object' && value !== null
        ? (value as { url?: unknown; token?: unknown; username?: unknown; password?: unknown })
        : undefined
  if (entry === undefined || typeof entry.url !== 'string') return undefined
  const u = new URL(httpUrl(expandBun(entry.url, env), file))
  let user = decodeURIComponent(u.username)
  let pass = decodeURIComponent(u.password)
  u.username = ''
  u.password = ''
  if (typeof entry.username === 'string') user = expandBun(entry.username, env)
  if (typeof entry.password === 'string') pass = expandBun(entry.password, env)
  const auth =
    typeof entry.token === 'string'
      ? `Bearer ${expandBun(entry.token, env)}`
      : user !== ''
        ? `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
        : undefined
  return { url: withSlash(u.href), ...(auth === undefined ? {} : { auth }) }
}

/**
 * The registry `scope` (`@vzn`) resolves to from `cwd`, `env` and `home`,
 * with the credentials configured for it.
 */
export function resolveRegistry(
  scope: string,
  cwd: string = process.cwd(),
  env: Env = process.env,
  home: string = os.homedir(),
): Registry {
  const userrc = npmEnv(env, 'userconfig') ?? path.join(home, '.npmrc')
  const rcs: { file: string; keys: Map<string, string> }[] = []
  // A cwd under home reaches the user's file as an ancestor; it is read once, last.
  const files = ancestors(cwd)
    .map((d) => path.join(d, '.npmrc'))
    .filter((f) => f !== userrc)
  for (const file of [...files, userrc]) {
    const text = readText(file)
    if (text !== undefined) rcs.push({ file, keys: parseNpmrc(text, env) })
  }
  const rcOf = (key: string) => rcs.find((rc) => rc.keys.has(key))
  const fromRc = (key: string): string | undefined => rcOf(key)?.keys.get(key)

  const scoped = rcOf(`${scope}:registry`)
  const envUrl = npmEnv(env, 'registry')
  const npmUrl = scoped?.keys.get(`${scope}:registry`) ?? envUrl ?? fromRc('registry')
  if (npmUrl !== undefined) {
    const where =
      scoped !== undefined
        ? scoped.file
        : envUrl !== undefined
          ? env['npm_config_registry'] !== undefined
            ? 'npm_config_registry'
            : 'NPM_CONFIG_REGISTRY'
          : rcOf('registry')!.file
    const url = withSlash(httpUrl(npmUrl, where))
    return {
      url,
      auth: (target) => {
        // npm's lookup: the target's own path, then each parent, under its host.
        const dart = nerfDart(target)
        for (
          let at = dart;
          at.length > 2;
          at = at.slice(0, at.lastIndexOf('/', at.length - 2) + 1)
        ) {
          const token = fromRc(`${at}:_authToken`)
          if (token !== undefined) return `Bearer ${token}`
          const basic = fromRc(`${at}:_auth`)
          if (basic !== undefined) return `Basic ${basic}`
        }
        return undefined
      },
    }
  }

  const bunfigs = [
    ...ancestors(cwd).map((d) => path.join(d, 'bunfig.toml')),
    path.join(env['XDG_CONFIG_HOME'] ?? home, '.bunfig.toml'),
  ]
  for (const file of bunfigs) {
    const text = readText(file)
    if (text === undefined) continue
    let install: Bunfig | undefined
    try {
      install = (Bun.TOML.parse(text) as { install?: Bunfig }).install
    } catch (err) {
      throw new UserError(
        `${file}: not valid TOML (${err instanceof Error ? err.message : String(err)})`,
      )
    }
    const found =
      bunRegistry(install?.scopes?.[scope] ?? install?.scopes?.[scope.slice(1)], env, file) ??
      bunRegistry(install?.registry, env, file)
    if (found === undefined) continue
    return {
      url: found.url,
      auth: (target) => (withSlash(target).startsWith(found.url) ? found.auth : undefined),
    }
  }
  return { url: NPMJS, auth: () => undefined }
}

function ancestors(cwd: string): string[] {
  const out: string[] = []
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    out.push(dir)
    if (path.dirname(dir) === dir) return out
  }
}
