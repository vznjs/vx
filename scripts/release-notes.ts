#!/usr/bin/env bun
// Generate release notes for a new vx tag.
//
// Inputs (env):
//   PREV_TAG        — last released tag (e.g. "v0.1.4"). Optional;
//                     when missing we summarize from the first commit.
//   NEW_TAG         — the tag we're about to cut (e.g. "v0.1.5").
//   ANTHROPIC_API_KEY — if set, we ask Claude to summarize the diff
//                     into human-readable notes. If unset, we fall
//                     back to a structured `git log` dump (one commit
//                     subject per line).
//
// Output: writes the notes to `release-notes.md` in cwd (the workflow
// then passes it to `gh release create --notes-file`). Also echoes a
// short status to stderr so the workflow log is readable.

export {}

const PREV_TAG = (process.env['PREV_TAG'] ?? '').trim()
const NEW_TAG = (process.env['NEW_TAG'] ?? '').trim()
const API_KEY = process.env['ANTHROPIC_API_KEY']

if (!NEW_TAG) {
  process.stderr.write('release-notes: NEW_TAG env var is required\n')
  process.exit(1)
}

const range = PREV_TAG ? `${PREV_TAG}..HEAD` : 'HEAD'

function gitCapture(args: string[]): string {
  const proc = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr)
    throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`)
  }
  return new TextDecoder().decode(proc.stdout)
}

// Commit subjects + bodies, oldest first. `%h` short hash, `%s`
// subject, `%b` body (squash-merge commits drop the PR body into
// here so descriptions survive).
const log = gitCapture([
  'log',
  range,
  '--reverse',
  '--no-merges',
  '--pretty=format:%h %s%n%b%n---END---',
]).trim()

if (log.length === 0) {
  await Bun.write('release-notes.md', `Release ${NEW_TAG}.\n\nNo new commits since ${PREV_TAG}.\n`)
  process.stderr.write('release-notes: empty range — wrote placeholder\n')
  process.exit(0)
}

function fallback(): string {
  const subjects = gitCapture(['log', range, '--reverse', '--no-merges', '--pretty=format:%s'])
    .split('\n')
    .filter((s) => s.length > 0)
    .map((s) => `- ${s}`)
    .join('\n')
  return `Release ${NEW_TAG}\n\n## Changes\n\n${subjects}\n`
}

if (!API_KEY) {
  await Bun.write('release-notes.md', fallback())
  process.stderr.write('release-notes: no ANTHROPIC_API_KEY — wrote plain git log fallback\n')
  process.exit(0)
}

// Ask Claude for a tight human-readable summary. Prompt asks for
// grouped sections and explicit feature / fix / docs callouts so the
// notes are scannable on the GitHub releases page.
const prompt = `You are writing GitHub release notes for "@vzn/vx", a monorepo task runner.

The release tag is **${NEW_TAG}** (the previous tag was ${PREV_TAG || '(none — first release)'}).

Below are the git commits since the previous tag, oldest first. Each
commit is its full message (subject + squash-merge body). Group
related work, write in present tense, keep it skim-friendly.

Format:
- Start with a one-sentence summary line (no heading).
- Then sections in this order, only included if non-empty:
  ### Features
  ### Fixes
  ### Docs
  ### Internal / Refactors
- Bullet points under each. Mention the user-facing flag / config
  field where relevant (e.g. \`--dry=json\`, \`exec.persistent.readyWhen\`).
- Skip noise: don't list "format", "ci: bump", or doc-only typo fixes
  unless they're the entire release.

Commits:

${log}`

const response = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': API_KEY,
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  }),
})

if (!response.ok) {
  const body = await response.text()
  process.stderr.write(
    `release-notes: Claude API ${response.status} — falling back to git log. Body: ${body.slice(0, 500)}\n`,
  )
  await Bun.write('release-notes.md', fallback())
  process.exit(0)
}

interface ClaudeResponse {
  content: Array<{ type: string; text?: string }>
}
const data = (await response.json()) as ClaudeResponse
const text = data.content
  .filter((b) => b.type === 'text')
  .map((b) => b.text ?? '')
  .join('\n')
  .trim()

if (text.length === 0) {
  process.stderr.write('release-notes: Claude returned no text — falling back\n')
  await Bun.write('release-notes.md', `Release ${NEW_TAG}\n\nSee commits below.\n`)
  process.exit(0)
}

await Bun.write('release-notes.md', text + '\n')
process.stderr.write(`release-notes: wrote ${text.length} chars from Claude\n`)
