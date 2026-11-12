// The migration seam an adoption tool calls: `workspace` writes the plan,
// `report` draws what it did.

import { drawMigration } from '../report/index.js'
import { writeMigration, type ApplyMigrationArgs } from '../workspace/index.js'

/**
 * Render a plan to files, refuse to overwrite without `force`, write (or
 * print, under `dry`), and report. Returns the process exit code.
 */
export async function applyMigration(args: ApplyMigrationArgs): Promise<number> {
  return drawMigration(await writeMigration(args))
}
