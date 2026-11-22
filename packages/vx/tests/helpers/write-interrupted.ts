// Writes big files one after another under `exitOnStop`, as `vx lock` writes
// its review copies, until a signal ends it. argv: <root> <bytes per file>.
import path from 'node:path'
import { exitOnStop, writeNoFollow } from '../../src/util/index.js'

const [root, bytes] = [process.argv[2]!, Number(process.argv[3])]
const text = 'x'.repeat(bytes)
await exitOnStop(async () => {
  process.stdout.write('writing\n')
  for (let i = 0; ; i++) await writeNoFollow(path.join(root, `f${i % 4}`), text, root)
})
