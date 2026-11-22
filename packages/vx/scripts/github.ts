// What the release scripts share: a required env var, GitHub's REST API as
// the job's token, and a main that fails with its message alone.

export function env(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}

interface Init {
  method?: string
  body?: string | Blob
  headers?: Record<string, string>
  signal?: AbortSignal
}

/**
 * GitHub's REST API for GITHUB_REPOSITORY as GH_TOKEN. A route is under
 * `repos/<repo>/`, or a full URL (uploads.github.com). Answers the JSON
 * body, null when there is none; any other status throws.
 */
export function github(): (route: string, init?: Init) => Promise<unknown> {
  const repo = env('GITHUB_REPOSITORY')
  const headers = {
    authorization: `Bearer ${env('GH_TOKEN')}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  }
  return async (route, init = {}) => {
    const url = route.startsWith('https://')
      ? route
      : `https://api.github.com/repos/${repo}/${route}`
    const res = await fetch(url, { ...init, headers: { ...headers, ...init.headers } })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`${init.method ?? 'GET'} ${url}: ${res.status} ${res.statusText}\n${text}`)
    }
    return text === '' ? null : JSON.parse(text)
  }
}

/** Run a script's main: a failure prints its message, not a stack, and exits 1. */
export async function runMain(main: () => Promise<void>): Promise<void> {
  try {
    await main()
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`)
    process.exitCode = 1
  }
}
