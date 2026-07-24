// Credentials: api tokens (sha256 at rest, immutable trust tier), dashboard
// sessions, invite links (docs/design/cloud-platform-2026-07.md §5.3).

export const sql = `
CREATE TYPE trust_tier AS ENUM ('trusted', 'untrusted');
CREATE TYPE token_kind AS ENUM ('ci', 'admin');

CREATE TABLE api_tokens (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   bytea NOT NULL UNIQUE,
  kind         token_kind NOT NULL DEFAULT 'ci',
  trust_tier   trust_tier NOT NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   bigint NOT NULL,
  last_used_at bigint,
  expires_at   bigint,
  revoked_at   bigint
);
CREATE INDEX api_tokens_org ON api_tokens (org_id);

CREATE TABLE sessions (
  id_hash    bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  ip         text,
  user_agent text
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE invites (
  id         uuid PRIMARY KEY,
  org_id     uuid REFERENCES organizations(id) ON DELETE CASCADE,
  role       org_role,
  token_hash bytea NOT NULL UNIQUE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  used_by    uuid REFERENCES users(id)
);
`
