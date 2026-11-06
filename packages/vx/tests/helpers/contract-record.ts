import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Under `VX_UPDATE_CONTRACT=1`, write `value` to the JSON record `file` only
 * when it says something else: a regeneration with nothing to change leaves
 * the committed (formatted) bytes alone, so it dirties no tree and rewrites
 * no file another test reads at the same time.
 */
export function updateJsonRecord(file: string, value: unknown): void {
  if (process.env['VX_UPDATE_CONTRACT'] !== '1' || process.env['CI'] === 'true') return
  let recorded: unknown
  try {
    recorded = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // absent or unreadable: write it
  }
  if (!Bun.deepEquals(recorded, value)) writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}
