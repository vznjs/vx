// Identity: users, organizations, memberships, teams
// (docs/design/cloud-platform-2026-07.md §5.2). Conventions: UUIDv7 PKs
// generated app-side, bigint ms-epoch timestamps.

export const sql = `
CREATE TABLE users (
  id             uuid PRIMARY KEY,
  email          text NOT NULL UNIQUE,
  display_name   text NOT NULL,
  password_hash  text NOT NULL,
  instance_admin boolean NOT NULL DEFAULT false,
  disabled_at    bigint,
  created_at     bigint NOT NULL
);

CREATE TABLE organizations (
  id         uuid PRIMARY KEY,
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  created_at bigint NOT NULL
);

CREATE TYPE org_role AS ENUM ('owner', 'admin', 'member', 'viewer');

CREATE TABLE org_memberships (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       org_role NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX org_memberships_user ON org_memberships (user_id);

CREATE TABLE teams (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug       text NOT NULL,
  name       text NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (org_id, slug)
);

CREATE TABLE team_memberships (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);
`
