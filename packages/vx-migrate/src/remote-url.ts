import { UserError } from '@vzn/vx'

/**
 * A remote cache's URL, refused as `from` names it (an option, a variable,
 * a config file). Shared by `turboCache()` and `nxCache()`, at the call for
 * the option and when the cache opens for every source.
 *
 * Plain http:// to any host is taken, where vxCache() takes it only to
 * loopback: Turbo and Nx both send their token over it, and their
 * self-hosted servers document such URLs (`TURBO_API=http://cache:3000`
 * beside a CI service container; nx-cache-server's
 * `NX_SELF_HOSTED_REMOTE_CACHE_SERVER=http://your-server:3000`). These
 * plugins run such a repo unchanged.
 */
export function checkRemoteUrl(url: string, from: string): void {
  // With no scheme every request failed on its own, as a bare "Invalid URL".
  if (!/^https?:\/\//.test(url))
    throw new UserError(`${from} must be an http(s) URL, got ${JSON.stringify(url)}`)
  // The URL is printed in every refusal line, so a `user:pass@` in it would
  // leak to the log. Credentials go in the token.
  if (URL.canParse(url)) {
    const u = new URL(url)
    if (u.username !== '' || u.password !== '')
      throw new UserError(
        `${from} carries credentials (user:pass@); pass them as the token instead`,
      )
  }
}
