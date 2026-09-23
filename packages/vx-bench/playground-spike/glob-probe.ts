// W9 spike (item 676): single `Bun.Glob.match` answers, to pin a rule the
// differential fuzz (`glob-equiv.ts`) disagrees on.
//
//   bun packages/vx-bench/playground-spike/glob-probe.ts '<pattern>' '<path>' ...
//
// With no arguments it prints the fixed table below.

const fixed: Array<[string, string]> = [
  ['*', ''],
  ['a/*', 'a/'],
  ['**', ''],
  ['**/*', ''],
  ['**/*', 'a/'],
  ['**/*', 'a'],
  ['x/**/*', 'x/'],
  ['?**', 'a/b'],
  ['?**', 'ab'],
  ['b**', 'bx/y'],
  ['b**/**', 'bx'],
  ['b**/**', 'bx/y'],
  ['b**/**', 'b/y'],
  ['b**/**/c', 'bxc'],
  ['b**/**/c', 'bx/c'],
  ['{a,}*', ''],
  ['{a,}', ''],
  ['a{,b}', 'a'],
  ['**/', ''],
  ['a/**/', 'a/'],
  ['{**/,}x', 'x'],
  ['{a/**}', 'a/b/c'],
  ['{**,b}/c', 'x/y/c'],
  ['{a,}**/', ''],
  ['{a,}**', 'a/b'],
]

const args = process.argv.slice(2)
const pairs: Array<[string, string]> = []
for (let i = 0; i + 1 < args.length; i += 2) pairs.push([args[i]!, args[i + 1]!])
for (const [p, s] of pairs.length > 0 ? pairs : fixed) {
  console.log(JSON.stringify(p).padEnd(16), JSON.stringify(s).padEnd(10), new Bun.Glob(p).match(s))
}
