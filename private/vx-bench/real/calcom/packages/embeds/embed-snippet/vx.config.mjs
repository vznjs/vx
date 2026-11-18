import { task } from '../../../vx-preset.ts'

export default {
  tasks: {
    build: task({
      dependsOn: ['@calcom/embed-core#build'],
      command: 'npx rimraf dist && vite build && tsc --emitDeclarationOnly --declarationDir dist',
    }),
  },
}
