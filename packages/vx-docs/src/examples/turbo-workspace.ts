import { defineWorkspace } from '@vzn/vx'
import { turbo } from '@vzn/vx-migrate'

export default defineWorkspace({ plugins: [turbo()] })
