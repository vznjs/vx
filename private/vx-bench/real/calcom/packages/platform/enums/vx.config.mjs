import { task } from '../../../vx-preset.ts'

export default {
  tasks: {
    build: task({
      dependsOn: ['@calcom/platform-constants#build'],
      command: 'npx rimraf dist && tsc --build --force tsconfig.json',
    }),
  },
}
