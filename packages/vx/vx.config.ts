import { defineProject } from './src/index.ts'

export default defineProject({
  tasks: {
    ci: {
      dependsOn: ['lint', 'test'],
    },

    install: {
      dependsOn: ['^build'],
    },

    build: {
      dependsOn: ['build.bun'],
    },

    lint: {
      dependsOn: ['lint.oxlint', 'lint.oxfmt'],
    },

    test: {
      dependsOn: ['test.bun'],
    },

    'test.bun': {
      description: 'bun test against the tests/ tree (four shards)',
      dependsOn: ['test.bun.shard-1', 'test.bun.shard-2', 'test.bun.shard-3', 'test.bun.shard-4'],
    },

    'test.bun.shard-1': {
      description: 'bun test, shard 1 of 4',
      dependsOn: ['install'],
      exec: {
        command: 'bun test --shard=1/4',
        env: { passThrough: ['VX_REQUIRE_SANDBOX'] },
      },
      cache: {
        inputs: {
          files: ['**/*'],
        },
        outputs: { files: [] },
      },
    },

    'test.bun.shard-2': {
      description: 'bun test, shard 2 of 4',
      dependsOn: ['install'],
      exec: {
        command: 'bun test --shard=2/4',
        env: { passThrough: ['VX_REQUIRE_SANDBOX'] },
      },
      cache: {
        inputs: {
          files: ['**/*'],
        },
        outputs: { files: [] },
      },
    },

    'test.bun.shard-3': {
      description: 'bun test, shard 3 of 4',
      dependsOn: ['install'],
      exec: {
        command: 'bun test --shard=3/4',
        env: { passThrough: ['VX_REQUIRE_SANDBOX'] },
      },
      cache: {
        inputs: {
          files: ['**/*'],
        },
        outputs: { files: [] },
      },
    },

    'test.bun.shard-4': {
      description: 'bun test, shard 4 of 4',
      dependsOn: ['install'],
      exec: {
        command: 'bun test --shard=4/4',
        env: { passThrough: ['VX_REQUIRE_SANDBOX'] },
      },
      cache: {
        inputs: {
          files: ['**/*'],
        },
        outputs: { files: [] },
      },
    },

    'lint.oxlint': {
      description: 'oxlint with tsgolint-backed type-aware checks',
      dependsOn: ['install'],
      exec: {
        command: 'oxlint --type-aware --type-check',
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            read: ['.', '../../bench/**'],
          },
        },
      },
      cache: {
        inputs: {
          files: ['**/*'],
        },
        outputs: { files: [] },
      },
    },

    'lint.oxfmt': {
      description: 'oxfmt --check (no rewrite; CI-safe)',
      dependsOn: ['install'],
      exec: {
        command: 'oxfmt --check .',
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
          },
        },
      },
      cache: {
        inputs: {
          files: ['**/*'],
        },
        outputs: { files: [] },
      },
    },

    'lint.oxfmt.fix': {
      description: 'oxfmt . — rewrite formatting in place',
      exec: {
        command: 'oxfmt .',
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
            write: ['**/*'],
          },
        },
      },
    },

    'build.bun': {
      description: 'compile standalone binaries for every target',
      dependsOn: [
        'build.bun.linux-x64',
        'build.bun.linux-arm64',
        'build.bun.darwin-x64',
        'build.bun.darwin-arm64',
      ],
    },

    'build.bun.linux-x64': {
      description: 'compile standalone binary (linux x64)',
      dependsOn: ['install'],
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-linux-x64 src/bin.ts --outfile dist/vx-linux-x64',
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space', 'net.link.addr'],
            read: ['.'],
            write: ['.', '~/.bun/install/cache/**'],
            network: ['registry.npmjs.org'],
          },
        },
      },
      cache: {
        inputs: { files: ['**/*'] },
        outputs: { files: ['dist/vx-linux-x64'] },
      },
    },

    'build.bun.linux-arm64': {
      description: 'compile standalone binary (linux arm64)',
      dependsOn: ['install'],
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-linux-arm64 src/bin.ts --outfile dist/vx-linux-arm64',
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space', 'net.link.addr'],
            read: ['.'],
            write: ['.', '~/.bun/install/cache/**'],
            network: ['registry.npmjs.org'],
          },
        },
      },
      cache: {
        inputs: { files: ['**/*'] },
        outputs: { files: ['dist/vx-linux-arm64'] },
      },
    },

    'build.bun.darwin-x64': {
      description: 'compile standalone binary (darwin x64)',
      dependsOn: ['install'],
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-darwin-x64 src/bin.ts --outfile dist/vx-darwin-x64',
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space', 'net.link.addr'],
            read: ['.'],
            write: ['.', '~/.bun/install/cache/**'],
            network: ['registry.npmjs.org'],
          },
        },
      },
      cache: {
        inputs: { files: ['**/*'] },
        outputs: { files: ['dist/vx-darwin-x64'] },
      },
    },

    'build.bun.darwin-arm64': {
      description: 'compile standalone binary (darwin arm64)',
      dependsOn: ['install'],
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-darwin-arm64 src/bin.ts --outfile dist/vx-darwin-arm64',
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space', 'net.link.addr'],
            read: ['.'],
            write: ['.', '~/.bun/install/cache/**'],
            network: ['registry.npmjs.org'],
          },
        },
      },
      cache: {
        inputs: { files: ['**/*'] },
        outputs: { files: ['dist/vx-darwin-arm64'] },
      },
    },
  },
})
