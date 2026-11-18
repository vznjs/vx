import { task } from '../../../vx-preset.ts'

export default {
  tasks: {
    build: task({
      command:
        'npx rimraf dist && NEXT_PUBLIC_EMBED_FINGER_PRINT=$(git rev-parse --short HEAD) NEXT_PUBLIC_EMBED_VERSION=$(node -p \'require("./package.json").version\') yarn __build',
      env: [
        'EMBED_PUBLIC_VERCEL_URL',
        'EMBED_PUBLIC_WEBAPP_URL',
        'EMBED_PUBLIC_EMBED_FINGER_PRINT',
        'EMBED_PUBLIC_EMBED_VERSION',
      ],
      uncached: true,
    }),
  },
}
