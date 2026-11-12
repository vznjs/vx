// A migration's report: `workspace` writes the plan and answers with what
// it did; this draws it. It writes no file (orchestrator/migration.ts
// composes the two).

import * as ui from '../ui/index.js'
import { VERSION } from '../version.js'
import type { MigrationReport } from '../workspace/index.js'

/**
 * Draw what a migration did: under `--json` its one document, else the
 * dry run's files, a lock refusal and the report. Returns the exit code.
 */
export function drawMigration(done: MigrationReport | { readonly json: string }): number {
  if ('json' in done) {
    ui.data('out', done.json)
    return 0
  }
  return drawReport(done)
}

/** Files named one per line; past this, the root's and a count (TanStack form: 97). */
const FILES_SHOWN = 10

function fileLines(paths: readonly string[]): string[] {
  if (paths.length <= FILES_SHOWN) return [...paths]
  const root = paths.filter((p) => !p.includes('/') || p.startsWith('.vx/'))
  return [...root, `and ${paths.length - root.length} more in package directories`]
}

/** Ids named per shared TODO; the files carry each one (sveltejs/kit: 92 persistent tasks). */
const TODO_IDS_SHOWN = 5

function drawReport(r: MigrationReport): number {
  for (const f of r.shown) ui.print('out', ui.excerpt(f.relPath, f.contents))
  const lock = r.lock
  // The lock's own words become a row; a refusal prints above the report.
  if (lock !== undefined && lock.code !== 0) ui.data('err', lock.said)

  const rows: ui.FieldRow[] = [['from', r.source]]
  if (r.dry) rows.push(['dry run', 'nothing written'])
  for (const [label, value] of r.steps) rows.push([label, value])
  if (r.empty !== undefined) {
    rows.push(['tasks', [ui.dim('none'), `: ${r.empty}`]])
  } else {
    const parts = [
      ...(r.clean > 0 ? [ui.tone('ok', `${r.clean} clean`)] : []),
      ...(r.todo > 0 ? [ui.tone('warn', `${r.todo} todo`)] : []),
    ]
    if (parts.length > 0)
      rows.push(['tasks', parts.flatMap((p, i) => (i === 0 ? [p] : [ui.dim(' · '), p]))])
    const todoLines: string[] = []
    for (const [reason, ids] of r.todos) {
      if (ids.length === 1) todoLines.push(`${ids[0]}: ${reason}`)
      else {
        const shown = ids.slice(0, TODO_IDS_SHOWN).join(', ')
        const more = ids.length - TODO_IDS_SHOWN
        todoLines.push(`${shown}${more > 0 ? ` and ${more} more` : ''}:`, `  ${reason}`)
      }
    }
    if (todoLines.length > 0) rows.push(['todo', ...todoLines])
  }
  if (r.files.length > 0) rows.push(['files', ...fileLines(r.files)])
  if (r.kept.length > 0) rows.push(['kept', ...r.kept])
  if (r.replaced.length > 0) rows.push(['replaced', ...r.replaced])
  if (lock !== undefined) {
    rows.push([
      'lock',
      lock.code === 0
        ? lock.said.trim().replace(/^✓ vx lock\s+/, '')
        : ui.tone('error', 'not written'),
    ])
  }
  if (r.notes.length > 0) rows.push(['note', ...r.notes])
  if (r.example !== undefined) rows.push(['example', r.example[0], '', r.example[1]])
  const said =
    lock === undefined || lock.code === 0 ? r.next : `fix the above, then vx lock and ${r.next}`
  rows.push(null, ['next', said])
  ui.print('out', ui.report(`${r.verb} ${VERSION}`, rows))
  return lock === undefined || lock.code === 0 ? 0 : 1
}
