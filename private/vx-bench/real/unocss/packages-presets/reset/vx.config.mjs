import { build } from '../../vx-preset.ts'

export default {
  tasks: {
    // The script copies the stylesheets beside the package, not into `dist`:
    // turbo.json's `dist/**` holds none of them, so its hit restores nothing.
    build: {
      ...build('tsx scripts/copy.ts'),
      outputs: { files: ['normalize.css', 'sanitize/**'] },
    },
  },
}
