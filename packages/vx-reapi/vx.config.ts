import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    install: {
      dependsOn: ['^build'],
    },

    // Lint only, deliberately. This package's suite needs a live bazel-remote
    // AND a live NativeLink, and it must run ONE PROCESS PER FILE (the
    // documented node:http2 stall, oven-sh/bun#39796) — conditions the CI
    // gate does not provide and a cached task cannot express. `.github`'s
    // separate `plugin packages` job owns that; this makes sure the SOURCE
    // is still checked, which before now it never was.
    ci: {
      dependsOn: ['lint'],
    },

    lint: {
      dependsOn: ['lint.oxlint', 'lint.oxfmt'],
    },

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
  },
})
