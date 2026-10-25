// Module contract, and the `@vzn/vx/oidc` entry: it imports only jose, so
// a server on Workers bundles it without the rest of core.

export {
  type Access,
  type Authorize,
  oidcAuth,
  type OidcOptions,
  parseTrust,
  Refusal,
  TRUSTED,
  type TrustRule,
} from './oidc.js'
