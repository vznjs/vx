import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    ci: {
      dependsOn: ['build', 'site-check'],
    },

    'site-check': {
      description: 'the site matches bench/results.json (bench/update-site.ts --check)',
      exec: {
        command: 'bun ../../bench/update-site.ts --check',
        sandbox: {
          allow: {
            read: ['**/*', '../../bench/**', '../../docs/**'],
            systemInfo: ['vfs.disk-space'],
          },
        },
      },
      cache: {
        inputs: {
          files: ['src/pages/index.astro'],
          workspaceFiles: ['bench/results.json', 'bench/update-site.ts', 'docs/benchmarks.md'],
        },
        outputs: { files: [] },
      },
    },

    import: {
      description: 'generate Starlight content from docs/ (codegen)',
      exec: {
        command: 'bun scripts/import-docs.ts',
        sandbox: {
          allow: {
            read: ['**/*', '../../docs/**'],
            write: ['src/content/docs/**'],
            systemInfo: ['vfs.disk-space'],
          },
        },
      },
    },

    install: {
      dependsOn: ['^build'],
    },

    build: {
      description: 'astro build → dist/',
      dependsOn: ['install', 'import'],
      exec: {
        command: 'astro build',
        sandbox: {
          allow: {
            read: ['**/*', '../../docs/**'],
            write: ['dist/**', '.astro/**', 'node_modules/.astro/**', 'node_modules/.vite/**'],
            systemInfo: ['vfs.disk-space', 'net.link.addr'],
            machLookup: ['com.apple.SystemConfiguration.DNSConfiguration'],
            localBinding: true,
          },
        },
      },
      cache: {
        inputs: {
          files: ['**/*'],
          workspaceFiles: ['docs/**'],
        },
        outputs: { files: ['dist/**'] },
      },
    },

    dev: {
      description: 'astro dev server (persistent)',
      dependsOn: ['import'],
      exec: {
        command: 'astro dev',
        persistent: { readyWhen: 'Local' },
        timeout: 120000,
        sandbox: {
          allow: {
            read: ['**/*', '../../docs/**'],
            write: ['.astro/**', 'node_modules/.astro/**', 'node_modules/.vite/**'],
            systemInfo: ['vfs.disk-space', 'net.link.addr'],
            machLookup: ['com.apple.SystemConfiguration.DNSConfiguration'],
            localBinding: true,
          },
        },
      },
    },

    preview: {
      description: 'serve the built dist/ (persistent)',
      dependsOn: ['build'],
      exec: {
        command: 'astro preview',
        persistent: { readyWhen: 'Local' },
        timeout: 120000,
        sandbox: {
          allow: {
            read: ['**/*'],
            systemInfo: ['vfs.disk-space', 'net.link.addr'],
            machLookup: ['com.apple.SystemConfiguration.DNSConfiguration'],
            localBinding: true,
          },
        },
      },
    },
  },
})
