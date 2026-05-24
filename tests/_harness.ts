import { run } from 'mitata'

export async function runBench(): Promise<void> {
  await run({
    colors: process.stdout.isTTY,
    format: 'mitata',
  })
}
