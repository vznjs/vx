import { task } from '../../vx-preset.ts'

export default {
  tasks: {
    'post-install': task({
      command: 'yarn generate-schemas',
      env: ['PRISMA_GENERATE_DATAPROXY'],
      uncached: true,
    }),
    build: task({
      dependsOn: ['post-install'],
      command: 'ts-node --transpile-only ./auto-migrations.ts',
      uncached: true,
    }),
  },
}
