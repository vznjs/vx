import { task } from '../../vx-preset.ts'

export default {
  tasks: {
    // Reads every app's folder and writes the generated indexes beside them.
    build: task({
      command: 'ts-node --transpile-only src/build.ts',
      files: ['src/**'],
      workspaceFiles: [
        'packages/app-store/**/package.json',
        'packages/app-store/**/config.json',
        'packages/app-store/**/api/**',
        'packages/app-store/**/components/**',
        'packages/app-store/**/lib/**',
        'packages/app-store/**/pages/**',
      ],
      outputs: {
        files: [],
        workspaceFiles: ['packages/app-store/*.generated.ts', 'packages/app-store/*.generated.tsx'],
      },
    }),
  },
}
