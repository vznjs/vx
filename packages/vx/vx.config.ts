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
      description: 'bun test',
      dependsOn: [
        'test.bun.shard-1',
        'test.bun.shard-2',
        'test.bun.shard-3',
        'test.bun.shard-4',
        'test.bun.shard-5',
        'test.bun.shard-6',
        'test.bun.shard-7',
        'test.bun.shard-8',
        'test.bun.unsafe',
      ],
    },

    'test.bun.unsafe': {
      description: 'bun test — the files a sandbox cannot host',
      dependsOn: ['install'],
      exec: {
        command: 'bun test ./tests/*.unsafe.test.ts',
        env: { passThrough: ['VX_REQUIRE_SANDBOX'] },
      },
      cache: {
        inputs: {
          files: ['**/*'],
        },
        outputs: { files: [] },
      },
    },

    'test.bun.shard-1': {
      description: 'bun test',
      dependsOn: ['install'],
      exec: {
        command: 'bun test --shard=1/8 --path-ignore-patterns="**/*.unsafe.test.ts"',
        env: { passThrough: ['VX_REQUIRE_SANDBOX'] },
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            machLookup: ['com.apple.FSEvents'],
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

    'test.bun.shard-2': {
      description: 'bun test',
      dependsOn: ['install'],
      exec: {
        command: 'bun test --shard=2/8 --path-ignore-patterns="**/*.unsafe.test.ts"',
        env: { passThrough: ['VX_REQUIRE_SANDBOX'] },
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            machLookup: ['com.apple.FSEvents'],
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

    'test.bun.shard-3': {
      description: 'bun test',
      dependsOn: ['install'],
      exec: {
        command: 'bun test --shard=3/8 --path-ignore-patterns="**/*.unsafe.test.ts"',
        env: { passThrough: ['VX_REQUIRE_SANDBOX'] },
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            machLookup: ['com.apple.FSEvents'],
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

    'test.bun.shard-4': {
      description: 'bun test',
      dependsOn: ['install'],
      exec: {
        command: 'bun test --shard=4/8 --path-ignore-patterns="**/*.unsafe.test.ts"',
        env: { passThrough: ['VX_REQUIRE_SANDBOX'] },
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            machLookup: ['com.apple.FSEvents'],
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

    'test.bun.shard-5': {
      description: 'bun test',
      dependsOn: ['install'],
      exec: {
        command: 'bun test --shard=5/8 --path-ignore-patterns="**/*.unsafe.test.ts"',
        env: { passThrough: ['VX_REQUIRE_SANDBOX'] },
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            machLookup: ['com.apple.FSEvents'],
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

    'test.bun.shard-6': {
      description: 'bun test',
      dependsOn: ['install'],
      exec: {
        command: 'bun test --shard=6/8 --path-ignore-patterns="**/*.unsafe.test.ts"',
        env: { passThrough: ['VX_REQUIRE_SANDBOX'] },
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            machLookup: ['com.apple.FSEvents'],
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

    'test.bun.shard-7': {
      description: 'bun test',
      dependsOn: ['install'],
      exec: {
        command: 'bun test --shard=7/8 --path-ignore-patterns="**/*.unsafe.test.ts"',
        env: { passThrough: ['VX_REQUIRE_SANDBOX'] },
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            machLookup: ['com.apple.FSEvents'],
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

    'test.bun.shard-8': {
      description: 'bun test',
      dependsOn: ['install'],
      exec: {
        command: 'bun test --shard=8/8 --path-ignore-patterns="**/*.unsafe.test.ts"',
        env: { passThrough: ['VX_REQUIRE_SANDBOX'] },
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            machLookup: ['com.apple.FSEvents'],
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

    'lint.oxlint': {
      description: 'oxlint with tsgolint-backed type-aware checks',
      dependsOn: ['install'],
      exec: {
        command: 'oxlint --type-aware --type-check',
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
            write: ['.'],
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
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
            write: ['dist/vx-linux-x64'],
          },
          ignore: {
            write: ['*.bun-build'],
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
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
            write: ['dist/vx-linux-arm64'],
          },
          ignore: {
            write: ['*.bun-build'],
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
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
            write: ['dist/vx-darwin-x64'],
          },
          ignore: {
            write: ['*.bun-build'],
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
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
            write: ['dist/vx-darwin-arm64'],
          },
          ignore: {
            write: ['*.bun-build'],
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
