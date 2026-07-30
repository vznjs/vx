// `invites.used_by` was the one user-referencing FK in the schema with no
// `ON DELETE` clause — both `created_by` columns beside it (api_tokens and
// invites) declare `ON DELETE SET NULL`. Postgres defaults to NO ACTION, so
// deleting a user who ever ACCEPTED an invite fails on a foreign-key violation
// while deleting one who only ever CREATED invites succeeds.
//
// Latent today — no route deletes a user — which is exactly why it is worth
// fixing now: the bug surfaces the day someone writes account deletion, and it
// surfaces only for the users who onboarded via invite, i.e. the ones an
// invite-only instance is mostly made of. That reads as a data-integrity
// mystery rather than a missing clause.
//
// SET NULL matches the siblings and is right for the same reason: an invite row
// is an audit record of an onboarding that happened, so it should outlive the
// account with the reference blanked, not vanish or block the delete.

export const sql = `
ALTER TABLE invites DROP CONSTRAINT IF EXISTS invites_used_by_fkey;
ALTER TABLE invites ADD CONSTRAINT invites_used_by_fkey
  FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL;
`
