// The pages `vx docs` searches: core's reference, imported as text so the
// compiled binary carries them and an npm install reads them from the
// package (package.json `files`). Loaded only by `vx docs`.
import caching from '../../docs/caching.md' with { type: 'text' }
import cli from '../../docs/cli.md' with { type: 'text' }
import execution from '../../docs/execution.md' with { type: 'text' }
import features from '../../docs/features.md' with { type: 'text' }
import patterns from '../../docs/patterns.md' with { type: 'text' }
import schema from '../../docs/schema.md' with { type: 'text' }
import security from '../../docs/security.md' with { type: 'text' }

/** Page name (its file, no `.md`) → markdown. */
export const PAGES: Readonly<Record<string, string>> = {
  cli,
  schema,
  caching,
  execution,
  patterns,
  security,
  features,
}
