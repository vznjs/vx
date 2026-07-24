// Tenancy: workspaces, repos (client workspace-id → server workspace),
// projects + task catalog (docs/design/cloud-platform-2026-07.md §5.2).

export const sql = `
CREATE TABLE workspaces (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug       text NOT NULL,
  name       text NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (org_id, slug)
);

CREATE TABLE repos (
  id                  uuid PRIMARY KEY,
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_workspace_id text NOT NULL,
  remote_url          text,
  first_seen_at       bigint NOT NULL,
  last_seen_at        bigint NOT NULL,
  UNIQUE (org_id, client_workspace_id)
);
CREATE INDEX repos_workspace ON repos (workspace_id);

CREATE TABLE projects (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  first_seen_at bigint NOT NULL,
  last_seen_at  bigint NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE project_tasks (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task       text NOT NULL,
  config     jsonb,
  cacheable  boolean,
  is_group   boolean,
  persistent boolean,
  updated_at bigint NOT NULL,
  PRIMARY KEY (project_id, task)
);
`
