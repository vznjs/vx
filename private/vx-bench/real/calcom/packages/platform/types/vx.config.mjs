import { task } from '../../../vx-preset.ts'

export default {
  tasks: {
    build: task({
      dependsOn: ['@calcom/platform-constants#build', '@calcom/platform-enums#build'],
      command: 'yarn clean && tsc --build --force tsconfig.json',
    }),
  },
}
