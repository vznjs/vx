import { task } from '../../vx-preset.ts'

export default {
  tasks: {
    // Rewrites two tracked files (the sprite under apps/web and the icon names): nothing to restore.
    build: task({ command: 'node ./scripts/build-icons.mjs', outputs: { files: [] } }),
  },
}
