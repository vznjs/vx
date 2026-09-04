import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    // install -> lint/test, ordering only: this package's dependencies are
    // built before it is. The dependency INSTALL is the agent pool's
    // `prepare`, run once against the workspace every agent shares.
    install: {
      dependsOn: ['^build'],
    },

    ci: {
      dependsOn: ['lint', 'test'],
    },

    lint: {
      dependsOn: ['lint.oxlint', 'lint.oxfmt'],
    },

    // Both run in THIS package's directory over THIS package's files. The
    // linters were previously invoked once from core, which since the move
    // covered 225 of the repo's 426 files — every sibling package went
    // unchecked. A project lints itself.
    'lint.oxlint': {
      // Plain oxlint, not --type-aware: the root tsconfig's `include` covers
      // packages/vx only, so there is no type graph for this package to check
      // against. Type-aware linting here would be asserting on a program that
      // does not exist — it passed locally only because the checker silently
      // fell back to whatever it could resolve by walking up.
      description: 'oxlint',
      exec: { command: 'oxlint' },
      dependsOn: ['install'],
      cache: {
        inputs: {
          files: ['src/**', 'tests/**', 'package.json'],
          // The linter's config and the tsconfig live at the workspace root,
          // outside every project-relative glob. Declared as INPUTS — which
          // is what `workspaceFiles` is for — so editing them invalidates
          // this task. The command itself still runs here, not there.
          workspaceFiles: ['.oxlintrc.json', 'tsconfig.json'],
        },
        outputs: { files: [] },
      },
    },

    'lint.oxfmt': {
      description: 'oxfmt --check (no rewrite; CI-safe)',
      exec: { command: 'oxfmt --check .' },
      dependsOn: ['install'],
      cache: {
        inputs: {
          files: ['**/*'],
          workspaceFiles: ['.oxfmtrc.json'],
        },
        outputs: { files: [] },
      },
    },

    test: {
      description: 'bun test',
      exec: { command: 'bun test' },
      dependsOn: ['install'],
      cache: {
        inputs: { files: ['src/**', 'tests/**', 'package.json'] },
        outputs: { files: [] },
      },
    },
  },
})
