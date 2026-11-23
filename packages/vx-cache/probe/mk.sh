#!/bin/bash
# mk.sh <dir> <url>
set -e; D=$1; rm -rf $D; mkdir -p $D/.vx $D/p/src; cd $D
CACHE=/home/user/vx/packages/vx-cache/src/index.ts
echo '{"name":"ws","private":true}' > package.json
printf 'dist\n.vx/cache\n' > .gitignore
echo 'console.log(1)' > p/src/a.js
cat > .vx/workspace.mjs <<W
import { vxCache } from '$CACHE'
export default { plugins: [vxCache({ url: process.env.PROBE_URL, issuer: 'https://token.actions.githubusercontent.com', repository: 'acme/app' })] }
W
cat > p/vx.config.mjs <<'C'
export default { name: 'p', tasks: {
  build: { exec: { command: 'mkdir -p dist && cp src/a.js dist/a.js && head -c ${SZ:-100000} /dev/urandom > dist/blob' , env: { passThrough: ['SZ'] } }, inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true },
  use: { dependsOn: ['build'], exec: { command: 'cat dist/a.js' } },
} }
C
git init -q -b main; bun /home/user/vx/packages/vx/src/bin.ts lock >/dev/null; git add -A; git -c user.email=t@x -c user.name=t commit -qm i
