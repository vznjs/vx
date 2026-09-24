// Is `/proc` this process's view of the pid namespace? A procfs mounted
// for another namespace is a table of strangers: under the sandbox's
// nested pid namespace vx is pid 2 while `/proc/self` names 7, and
// `/proc/<our child's pid>` is some other process or none (2026-09-24).
// Asked once per process: the mount does not change under a run.

import { readlinkSync } from 'node:fs'

let own: boolean | undefined

export function procfsIsOwn(): boolean {
  if (own === undefined) {
    try {
      own = process.platform === 'linux' && readlinkSync('/proc/self') === String(process.pid)
    } catch {
      own = false
    }
  }
  return own
}
