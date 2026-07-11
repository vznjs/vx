// The ordered migration set. Embedded TS modules (not fs-read .sql files) so
// `bun build --compile` bundles them into the binary — a readdir at runtime
// would find nothing inside a compiled executable.

import { sql as identity } from './0001_identity.js'
import { sql as tenancy } from './0002_tenancy.js'
import { sql as credentials } from './0003_credentials.js'
import { sql as analytics } from './0004_analytics.js'
import { sql as analyticsLogs } from './0005_analytics_logs.js'
import { sql as fingerprints } from './0006_fingerprints.js'

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'identity', sql: identity },
  { version: 2, name: 'tenancy', sql: tenancy },
  { version: 3, name: 'credentials', sql: credentials },
  { version: 4, name: 'analytics', sql: analytics },
  { version: 5, name: 'analytics_logs', sql: analyticsLogs },
  { version: 6, name: 'fingerprints', sql: fingerprints },
]
