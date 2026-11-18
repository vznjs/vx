import { task } from '../../vx-preset.ts'

export default {
  tasks: {
    build: task({
      dependsOn: ['@calcom/prisma#post-install'],
      command: 'yarn build:server && yarn build:react',
      outputs: { files: ['types/**'] },
    }),
  },
}
