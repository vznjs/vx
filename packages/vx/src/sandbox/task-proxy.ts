// One task's own proxy: the runtime's proxy is the run's and judges every
// connection by the union of all tasks' network lists, so a task reached a
// host only another task of the run declared. Each networked task gets this
// front on its own socket, which judges by the task's lists and hands what
// it allows to the run's proxy as its parent (that proxy still applies the
// union and its address guard). A task names itself to a proxy by a
// username it writes, so only the socket it was given says which task it is.

import { BlockList } from 'node:net'

/** The deep modules of the runtime the front is built from: its own proxy code, not a copy. */
async function loadProxyParts() {
  // Literal specifiers: `bun build --compile` embeds only what it can see.
  const [http, socks, mux, pattern, parent] = await Promise.all([
    import('@anthropic-ai/sandbox-runtime/dist/sandbox/http-proxy.js'),
    import('@anthropic-ai/sandbox-runtime/dist/sandbox/socks-proxy.js'),
    import('@anthropic-ai/sandbox-runtime/dist/sandbox/mux-proxy.js'),
    import('@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js'),
    import('@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js'),
  ])
  return { http, socks, mux, pattern, parent }
}

export interface TaskProxy {
  close(): Promise<void>
}

/**
 * Listen at `endpoint` (a unix socket path, or 0 for a localhost port) for
 * one task. Returns the bound port when `endpoint` is 0.
 */
export async function startTaskProxy(opts: {
  endpoint: string | 0
  allowed: readonly string[]
  denied: readonly string[]
  /** The run's proxy: its port and the session token both legs carry. */
  runProxyPort: number
  token: string
  /** The task's attribution key (`srt.<encodedCommand>`'s suffix). */
  encodedCommand: string
  /** A refusal this front made, in the runtime's own record form. */
  refused(line: string): void
}): Promise<TaskProxy & { port: number | undefined }> {
  const { http, socks, mux, pattern, parent } = await loadProxyParts()
  const filter = (port: number, host: string): boolean => {
    const deny = (reason: string) => {
      opts.refused(`deny network-outbound ${host}:${port} (${reason})`)
      return false
    }
    if (!parent.isValidHost(host)) return deny('malformed host')
    const canonical: string = parent.canonicalizeHost(host) ?? host
    if (opts.denied.some((d) => pattern.matchesDomainPatternWithPort(canonical, port, d)))
      return deny('host is on the deny list')
    if (opts.allowed.some((a) => pattern.matchesDomainPatternWithPort(canonical, port, a)))
      return true
    return deny('host is not on the allow list')
  }
  const user = encodeURIComponent(`srt.${opts.encodedCommand}`)
  const up = new URL(
    `http://${user}:${encodeURIComponent(opts.token)}@127.0.0.1:${opts.runProxyPort}`,
  )
  // Every allowed connection goes on to the run's proxy, which applies the
  // run's lists and address guard again; only a loopback host, which the
  // runtime never sends to a parent, is dialed from here, and only one the
  // task named.
  const parentProxy = {
    httpUrl: up,
    httpsUrl: up,
    noProxy: { all: false, suffixes: [], cidr: new BlockList() },
  }
  const httpServer = http.createHttpProxyServer({
    filter: (port: number, host: string) => filter(port, host),
    parentProxy,
    proxyAuthToken: opts.token,
  })
  const socksServer = socks.createSocksProxyServer({
    filter: (port: number, host: string) => filter(port, host),
    parentProxy,
    proxyAuthToken: opts.token,
  })
  const front = mux.createMuxProxyServer({
    httpServer,
    handleSocksConnection: (s) => socksServer.handleConnection(s),
  })
  await front.listenHttpBackend()
  await new Promise<void>((resolve, reject) => {
    front.server.once('error', reject)
    if (opts.endpoint === 0) front.server.listen(0, '127.0.0.1', () => resolve())
    else front.server.listen(opts.endpoint, () => resolve())
  })
  front.unref()
  return { port: front.getPort(), close: () => front.close() }
}
