// An execve's argv is printed inside the call: a command whose own words
// hold `) = -1 ENOENT` read as a denial of a call that succeeded, since the
// parse took the last such text on the line rather than the call's result.
import { expect, it } from 'bun:test'
import { deniedCalls } from '../src/exec/sandbox-violations.js'

it('reads a call result at the line end, never inside its argv', () => {
  const trace = [
    '10 execve("/bin/sh", ["sh", "-c", "echo \') = -1 ENOENT\'"], 0x7ffd /* 5 vars */) = 0',
    '10 execve("/bin/sh", ["sh", "-c", "echo \') = -1 EACCES (x)\'"], 0x7ffd /* 5 vars */) = 0',
    '11 execve("/usr/bin/nope", ["nope", ") = -1 EPERM"], 0x7ffd /* 5 vars */) = -1 ENOENT (No such file or directory)',
    '',
  ].join('\n')
  expect(deniedCalls(trace, '/ws').map((c) => [c.rawPath, c.errno])).toEqual([
    ['/usr/bin/nope', 'ENOENT'],
  ])
})
