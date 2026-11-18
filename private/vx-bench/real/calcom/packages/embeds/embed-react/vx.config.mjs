import { task } from '../../../vx-preset.ts'

export default {
  tasks: {
    build: task({
      dependsOn: ['@calcom/embed-core#build', '@calcom/embed-snippet#build'],
      command:
        'npx rimraf dist && vite build && npx shx cp ./dist/Cal.es.js ./dist/Cal.es.mjs && tsc --emitDeclarationOnly --declarationDir dist',
    }),
  },
}
