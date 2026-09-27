import path from 'node:path'

/**
 * Rewrites every command in the kept `<kind>` mapping to `echo from-cache`,
 * so a row sees whether the next run served the kept file or mapped afresh.
 */
export async function tamperMapping(root: string, kind: string): Promise<void> {
  const [file] = await Array.fromAsync(
    new Bun.Glob(`**/vx-migrate-${kind}-mapping.json`).scan({ cwd: root, dot: true }),
  )
  const held = await Bun.file(path.join(root, file!)).json()
  for (const [, p] of held.byName)
    for (const t of p.tasks) if (t.task?.exec) t.task.exec.command = 'echo from-cache'
  await Bun.write(path.join(root, file!), JSON.stringify(held))
}
