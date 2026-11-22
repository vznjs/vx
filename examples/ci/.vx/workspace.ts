import { defineWorkspace } from '@vzn/vx/config'
import { github } from '@vzn/vx-ci'
import { bun } from '@vzn/vx-lockfile'

export default defineWorkspace({
  plugins: [
    // Reads bun.lock, so `^build` builds a package's dependencies first.
    bun(),
    // On GitHub Actions: the job summary, and the pull request's base for
    // --affected. Anywhere else it does nothing.
    github(),
  ],
  // What each CI job runs: `vx pipeline pr`, `vx pipeline main`.
  pipelines: {
    // A pull request: only the projects it changed and the ones that
    // depend on them.
    pr: { tasks: ['build', 'test'], affected: true },
    // main and a merge queue: every project.
    main: { tasks: ['build', 'test'] },
  },
})
