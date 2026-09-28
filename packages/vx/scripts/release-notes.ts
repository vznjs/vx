// A release's notes from the Conventional Commits since the last tag
// (auto-release.yml). GitHub's generated notes listed every merged PR title,
// docs and tests included, so the user-facing change sat among dozens of
// internal ones. Here only feat, fix and perf are listed, a breaking change
// (`type!:` or a `BREAKING CHANGE:` footer) heads the notes, and the rest is
// one count.
//
//   bun packages/vx/scripts/release-notes.ts <from-ref> <to-ref>

export interface Commit {
  readonly subject: string
  readonly body: string
}

const SECTIONS = [
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
] as const

const HEADER = /^(\w+)(?:\(([^)]*)\))?(!)?: (.+)$/

/** `type!:` / `type(scope)!:`, or a `BREAKING CHANGE:` footer line. */
export function isBreaking({ subject, body }: Commit): boolean {
  return HEADER.exec(subject)?.[3] === '!' || /^BREAKING[ -]CHANGE: /m.test(body)
}

export function releaseNotes(commits: readonly Commit[]): string {
  const breaking: string[] = []
  const listed = new Map<string, string[]>(SECTIONS.map(([type]) => [type, []]))
  let other = 0
  for (const commit of commits) {
    const m = HEADER.exec(commit.subject)
    if (m === null) {
      other++
      continue
    }
    const [, type, scope, , summary] = m as unknown as [
      string,
      string,
      string | undefined,
      string | undefined,
      string,
    ]
    const line = `- ${scope ? `**${scope}:** ` : ''}${summary}`
    if (isBreaking(commit)) breaking.push(line)
    const section = listed.get(type)
    if (section === undefined) other++
    else section.push(line)
  }
  const out: string[] = []
  if (breaking.length > 0) out.push('## Breaking changes', '', ...breaking, '')
  for (const [type, title] of SECTIONS) {
    const lines = listed.get(type)!
    if (lines.length > 0) out.push(`## ${title}`, '', ...lines, '')
  }
  if (other > 0)
    out.push(`${other} other commit${other === 1 ? '' : 's'} (docs, tests, refactors, CI).`, '')
  return out.length === 0 ? 'No changes.\n' : out.join('\n')
}

/** The commits in `from..to`, oldest first; `from` empty means all history up to `to`. */
export function commitsBetween(from: string, to: string, cwd?: string): Commit[] {
  const range = from === '' ? to : `${from}..${to}`
  const r = Bun.spawnSync(['git', 'log', '--reverse', '--format=%s%x00%b%x1e', range], {
    ...(cwd !== undefined ? { cwd } : {}),
  })
  if (r.exitCode !== 0) throw new Error(`git log ${range} failed: ${r.stderr.toString().trim()}`)
  return parseLog(r.stdout.toString())
}

/** `git log --format=%s%x00%b%x1e` output → commits. */
export function parseLog(out: string): Commit[] {
  return out
    .split('\x1e')
    .map((rec) => rec.replace(/^\n/, ''))
    .filter((rec) => rec !== '')
    .map((rec) => {
      const [subject = '', body = ''] = rec.split('\0')
      return { subject, body }
    })
}

if (import.meta.main) {
  const [from = '', to = 'HEAD'] = process.argv.slice(2)
  process.stdout.write(releaseNotes(commitsBetween(from, to)))
}
