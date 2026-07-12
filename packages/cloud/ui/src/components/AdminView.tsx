// The Admin area (cloud-platform-2026-07 §6.4) — org administration for the
// signed-in user, scoped to the selected org. Sub-sections: Members · Invites ·
// Tokens · Workspaces · Settings. RBAC-aware (actions the caller's role can't
// perform are hidden/disabled) but the SERVER is the enforcer; the UI merely
// reflects. Interactive Solid throughout (like RunsView), not a JSON view.

import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  type JSX,
} from 'solid-js'
import { useSearchParams } from '@solidjs/router'
import {
  type AdminToken,
  type AdminWorkspace,
  type CreatedInvite,
  type CreatedToken,
  type OrgMember,
  type OrgRole,
  adminCreateInvite,
  adminCreateOrg,
  adminCreateToken,
  adminCreateWorkspace,
  adminListMembers,
  adminListTokens,
  adminListWorkspaces,
  adminRemoveMember,
  adminUpdateMemberRole,
  adminUpdateOrg,
  adminRevokeToken,
  getCurrentUserSignal,
  getOrgSignal,
  getOrgsSignal,
  refreshOrgs,
  refreshWorkspaces,
} from '../api.ts'
import { formatDate, formatRelativeTime } from '../format.ts'
import { Card, EmptyState } from './ui.tsx'

const ROLES: readonly OrgRole[] = ['owner', 'admin', 'member', 'viewer']

type Section = 'members' | 'invites' | 'tokens' | 'workspaces' | 'settings'
const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: 'members', label: 'Members', icon: 'i-tabler-users' },
  { id: 'invites', label: 'Invites', icon: 'i-tabler-mail-forward' },
  { id: 'tokens', label: 'Tokens', icon: 'i-tabler-key' },
  { id: 'workspaces', label: 'Workspaces', icon: 'i-tabler-folders' },
  { id: 'settings', label: 'Settings', icon: 'i-tabler-settings' },
]

export function AdminView() {
  const orgId = getOrgSignal()
  const user = getCurrentUserSignal()
  const orgs = getOrgsSignal()
  const [searchParams, setSearchParams] = useSearchParams()

  const section = (): Section => {
    const v = searchParams.section
    return SECTIONS.some((s) => s.id === v) ? (v as Section) : 'members'
  }
  const setSection = (s: Section): void => setSearchParams({ section: s === 'members' ? undefined : s })

  const currentOrg = () => orgs().find((o) => o.id === orgId())
  const role = createMemo<OrgRole | null>(() => {
    const u = user()
    if (u === null) return null
    if (u.instanceAdmin) return 'owner'
    return u.orgs.find((o) => o.orgId === orgId())?.role ?? null
  })
  const canAdmin = () => role() === 'admin' || role() === 'owner'
  const canOwner = () => role() === 'owner'

  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-center gap-3 flex-wrap">
        <div>
          <h1 class="text-lg font-semibold m-0 tracking-tight">Administration</h1>
          <p class="text-fg-3 text-[12px] m-0 mt-0.5">
            <Show when={currentOrg()} fallback={<>Manage your organization.</>}>
              {(o) => (
                <>
                  Organization <span class="font-mono text-fg-1">{o().name}</span>{' '}
                  <span class="text-fg-3">({o().slug})</span> · your role:{' '}
                  <span class="font-mono text-fg-1">{role() ?? '—'}</span>
                </>
              )}
            </Show>
          </p>
        </div>
      </div>

      {/* Sub-nav */}
      <div class="flex items-center gap-1 border-b border-border/70 text-[13px] overflow-x-auto">
        <For each={SECTIONS}>
          {(s) => (
            <button
              type="button"
              onClick={() => setSection(s.id)}
              class="flex items-center gap-1.5 px-3 py-2 transition whitespace-nowrap"
              classList={{
                'text-accent border-b-2 border-accent -mb-px font-medium': section() === s.id,
                'text-fg-3 hover:text-fg-2': section() !== s.id,
              }}
            >
              <span class={`${s.icon} text-base`} aria-hidden="true" />
              {s.label}
            </button>
          )}
        </For>
      </div>

      <Show
        when={orgId() !== '' && role() !== null}
        fallback={<EmptyState title="No organization selected" hint="Pick an org from the switcher, or create one in Settings." />}
      >
        <Show when={section() === 'members'}>
          <MembersSection orgId={orgId()} canAdmin={canAdmin()} canOwner={canOwner()} selfUserId={user()?.userId ?? ''} />
        </Show>
        <Show when={section() === 'invites'}>
          <InvitesSection orgId={orgId()} canAdmin={canAdmin()} canOwner={canOwner()} />
        </Show>
        <Show when={section() === 'tokens'}>
          <TokensSection orgId={orgId()} canAdmin={canAdmin()} />
        </Show>
        <Show when={section() === 'workspaces'}>
          <WorkspacesSection orgId={orgId()} canAdmin={canAdmin()} />
        </Show>
        <Show when={section() === 'settings'}>
          <SettingsSection orgId={orgId()} canAdmin={canAdmin()} instanceAdmin={user()?.instanceAdmin ?? false} />
        </Show>
      </Show>
    </div>
  )
}

// --- shared bits ------------------------------------------------------------

function Notice(props: { kind: 'error' | 'ok'; children: JSX.Element }) {
  return (
    <div
      class="rounded-lg px-3 py-2 text-[12px] border"
      classList={{
        'border-danger/40 bg-danger/5 text-danger': props.kind === 'error',
        'border-success/40 bg-success/5 text-success': props.kind === 'ok',
      }}
    >
      {props.children}
    </div>
  )
}

function CopyButton(props: { text: string }) {
  const [copied, setCopied] = createSignal(false)
  return (
    <button
      type="button"
      class="text-[11px] px-2 py-1 rounded border border-border text-fg-2 hover:text-fg hover:border-border-strong transition inline-flex items-center gap-1"
      onClick={() => {
        void navigator.clipboard?.writeText(props.text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      <span class={copied() ? 'i-tabler-check text-success' : 'i-tabler-copy'} aria-hidden="true" />
      {copied() ? 'copied' : 'copy'}
    </button>
  )
}

// --- Members ----------------------------------------------------------------

function MembersSection(props: { orgId: string; canAdmin: boolean; canOwner: boolean; selfUserId: string }) {
  const [bump, setBump] = createSignal(0)
  const [error, setError] = createSignal<string | null>(null)
  const [members] = createResource(
    () => `${props.orgId}|${bump()}`,
    () => adminListMembers(props.orgId).catch(() => null),
  )

  async function changeRole(userId: string, role: OrgRole): Promise<void> {
    setError(null)
    const r = await adminUpdateMemberRole(props.orgId, userId, role)
    if (!r.ok) setError(r.error ?? 'Could not change role.')
    setBump((v) => v + 1)
  }

  async function remove(userId: string): Promise<void> {
    setError(null)
    const r = await adminRemoveMember(props.orgId, userId)
    if (!r.ok) setError(r.error ?? 'Could not remove member.')
    setBump((v) => v + 1)
  }

  return (
    <Card title="Members" noPad>
      <Show when={error()}>
        <div class="p-3">
          <Notice kind="error">{error()}</Notice>
        </div>
      </Show>
      <Show
        when={(members() ?? []).length > 0}
        fallback={<EmptyState title="No members" hint="Invite teammates from the Invites tab." />}
      >
        <table class="w-full text-[13px]" data-testid="members-table">
          <thead>
            <tr class="text-left text-[10px] uppercase tracking-wider text-fg-3 border-b border-border/70">
              <th class="px-4 py-2 font-semibold">Email</th>
              <th class="px-4 py-2 font-semibold">Name</th>
              <th class="px-4 py-2 font-semibold">Role</th>
              <th class="px-4 py-2 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            <For each={members() ?? []}>
              {(m: OrgMember) => (
                <tr class="border-b border-border/40 last:border-0">
                  <td class="px-4 py-2 font-mono text-fg-1">{m.email}</td>
                  <td class="px-4 py-2 text-fg-2">{m.displayName}</td>
                  <td class="px-4 py-2">
                    <Show when={props.canAdmin} fallback={<span class="font-mono text-fg-2">{m.role}</span>}>
                      <select
                        value={m.role}
                        class="text-[12px]"
                        disabled={m.role === 'owner' && !props.canOwner}
                        onChange={(e) => void changeRole(m.userId, e.currentTarget.value as OrgRole)}
                      >
                        <For each={ROLES}>
                          {(r) => (
                            <option value={r} disabled={r === 'owner' && !props.canOwner}>
                              {r}
                            </option>
                          )}
                        </For>
                      </select>
                    </Show>
                  </td>
                  <td class="px-4 py-2 text-right">
                    <Show when={props.canAdmin && m.userId !== props.selfUserId}>
                      <button
                        type="button"
                        class="text-[11px] px-2 py-1 rounded border border-border text-danger hover:bg-danger/10 transition"
                        disabled={m.role === 'owner' && !props.canOwner}
                        onClick={() => void remove(m.userId)}
                      >
                        Remove
                      </button>
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </Card>
  )
}

// --- Invites ----------------------------------------------------------------

function InvitesSection(props: { orgId: string; canAdmin: boolean; canOwner: boolean }) {
  const [role, setRole] = createSignal<OrgRole>('member')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [created, setCreated] = createSignal<CreatedInvite | null>(null)

  async function create(e: Event): Promise<void> {
    e.preventDefault()
    if (busy()) return
    setError(null)
    setBusy(true)
    const r = await adminCreateInvite(props.orgId, role())
    setBusy(false)
    if (!r.ok || r.data === undefined) {
      setError(r.error ?? 'Could not create invite.')
      return
    }
    setCreated(r.data)
  }

  return (
    <Card title="Invite a teammate">
      <Show
        when={props.canAdmin}
        fallback={<Notice kind="error">Only an org admin or owner can create invites.</Notice>}
      >
        <p class="text-[12px] text-fg-3 mt-0 mb-3">
          An invite is a single-use link. Share it — the recipient registers with it to join this org.
        </p>
        <form class="flex items-end gap-2 flex-wrap" onSubmit={create}>
          <label class="flex flex-col gap-1">
            <span class="text-[11px] font-medium text-fg-2">Role</span>
            <select value={role()} class="text-[13px]" onChange={(e) => setRole(e.currentTarget.value as OrgRole)}>
              <For each={ROLES}>
                {(r) => (
                  <option value={r} disabled={r === 'owner' && !props.canOwner}>
                    {r}
                  </option>
                )}
              </For>
            </select>
          </label>
          <button
            type="submit"
            disabled={busy()}
            class="px-3.5 py-2 rounded-lg bg-accent text-bg font-medium text-[13px] hover:brightness-110 transition disabled:opacity-50"
          >
            Create invite
          </button>
        </form>

        <Show when={error()}>
          <div class="mt-3">
            <Notice kind="error">{error()}</Notice>
          </div>
        </Show>

        <Show when={created()}>
          {(inv) => (
            <div class="mt-4 rounded-lg border border-success/40 bg-success/5 p-3 flex flex-col gap-2" data-testid="invite-result">
              <div class="text-[12px] text-fg-1 font-medium">Invite created — share this link:</div>
              <div class="flex items-center gap-2">
                <code class="flex-1 min-w-0 truncate font-mono text-[12px] bg-surface-2 border border-border rounded px-2 py-1.5">
                  {inv().url}
                </code>
                <CopyButton text={inv().url} />
              </div>
              <div class="flex items-center gap-2">
                <span class="text-[11px] text-fg-3">Token:</span>
                <code class="font-mono text-[11px] text-fg-2 truncate">{inv().invite}</code>
                <CopyButton text={inv().invite} />
              </div>
              <div class="text-[11px] text-fg-3">Expires {formatDate(inv().expiresAt)}.</div>
            </div>
          )}
        </Show>
      </Show>
    </Card>
  )
}

// --- Tokens -----------------------------------------------------------------

function TokensSection(props: { orgId: string; canAdmin: boolean }) {
  const [bump, setBump] = createSignal(0)
  const [tokens] = createResource(
    () => `${props.orgId}|${bump()}`,
    () => adminListTokens(props.orgId).catch(() => null),
  )
  const [workspaces] = createResource(
    () => props.orgId,
    () => adminListWorkspaces(props.orgId).catch(() => [] as AdminWorkspace[]),
  )
  const [name, setName] = createSignal('')
  const [tier, setTier] = createSignal<'trusted' | 'untrusted'>('trusted')
  const [kind, setKind] = createSignal<'ci' | 'admin'>('ci')
  const [workspaceId, setWorkspaceId] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [minted, setMinted] = createSignal<CreatedToken | null>(null)

  async function create(e: Event): Promise<void> {
    e.preventDefault()
    if (busy() || name().trim() === '') return
    setError(null)
    setBusy(true)
    const r = await adminCreateToken(props.orgId, {
      name: name().trim(),
      tier: tier(),
      kind: kind(),
      ...(workspaceId() !== '' ? { workspaceId: workspaceId() } : {}),
    })
    setBusy(false)
    if (!r.ok || r.data === undefined) {
      setError(r.error ?? 'Could not create token.')
      return
    }
    setMinted(r.data)
    setName('')
    setBump((v) => v + 1)
  }

  async function revoke(id: string): Promise<void> {
    setError(null)
    const r = await adminRevokeToken(props.orgId, id)
    if (!r.ok) setError(r.error ?? 'Could not revoke token.')
    setBump((v) => v + 1)
  }

  const wsName = (id: string | null): string => {
    if (id === null) return 'org-wide'
    return (workspaces() ?? []).find((w) => w.id === id)?.slug ?? id.slice(0, 8)
  }

  return (
    <div class="flex flex-col gap-4">
      <Show when={props.canAdmin}>
        <Card title="Mint an API token">
          <p class="text-[12px] text-fg-3 mt-0 mb-3">
            CI and agents authenticate with a <code class="font-mono">vxc_</code> token. The trust tier is
            immutable and rides the token; a workspace-scoped token can only touch that workspace's cache.
          </p>
          <form class="flex items-end gap-2 flex-wrap" onSubmit={create}>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] font-medium text-fg-2">Name</span>
              <input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="ci" class="text-[13px] w-40" />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] font-medium text-fg-2">Tier</span>
              <select value={tier()} class="text-[13px]" onChange={(e) => setTier(e.currentTarget.value as 'trusted' | 'untrusted')}>
                <option value="trusted">trusted</option>
                <option value="untrusted">untrusted (fork PRs)</option>
              </select>
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] font-medium text-fg-2">Kind</span>
              <select value={kind()} class="text-[13px]" onChange={(e) => setKind(e.currentTarget.value as 'ci' | 'admin')}>
                <option value="ci">ci</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] font-medium text-fg-2">Workspace</span>
              <select value={workspaceId()} class="text-[13px]" onChange={(e) => setWorkspaceId(e.currentTarget.value)}>
                <option value="">org-wide</option>
                <For each={workspaces() ?? []}>{(w) => <option value={w.id}>{w.slug}</option>}</For>
              </select>
            </label>
            <button
              type="submit"
              disabled={busy() || name().trim() === ''}
              class="px-3.5 py-2 rounded-lg bg-accent text-bg font-medium text-[13px] hover:brightness-110 transition disabled:opacity-50"
            >
              Mint token
            </button>
          </form>

          <Show when={error()}>
            <div class="mt-3">
              <Notice kind="error">{error()}</Notice>
            </div>
          </Show>

          <Show when={minted()}>
            {(t) => (
              <div class="mt-4 rounded-lg border border-warn/50 bg-warn/[0.07] p-3 flex flex-col gap-2" data-testid="token-secret">
                <div class="text-[12px] text-fg-1 font-medium flex items-center gap-1.5">
                  <span class="i-tabler-alert-triangle text-warn" aria-hidden="true" />
                  Copy this token now — it will never be shown again.
                </div>
                <div class="flex items-center gap-2">
                  <code class="flex-1 min-w-0 truncate font-mono text-[12px] bg-surface-2 border border-border rounded px-2 py-1.5">
                    {t().token}
                  </code>
                  <CopyButton text={t().token} />
                </div>
              </div>
            )}
          </Show>
        </Card>
      </Show>

      <Card title="Tokens" noPad>
        <Show
          when={(tokens() ?? []).length > 0}
          fallback={<EmptyState title="No tokens" hint={props.canAdmin ? 'Mint one above for CI.' : 'An org admin mints CI tokens.'} />}
        >
          <table class="w-full text-[13px]" data-testid="tokens-table">
            <thead>
              <tr class="text-left text-[10px] uppercase tracking-wider text-fg-3 border-b border-border/70">
                <th class="px-4 py-2 font-semibold">Name</th>
                <th class="px-4 py-2 font-semibold">Kind</th>
                <th class="px-4 py-2 font-semibold">Tier</th>
                <th class="px-4 py-2 font-semibold">Scope</th>
                <th class="px-4 py-2 font-semibold">Created</th>
                <th class="px-4 py-2 font-semibold">Last used</th>
                <th class="px-4 py-2 font-semibold text-right" />
              </tr>
            </thead>
            <tbody>
              <For each={tokens() ?? []}>
                {(t: AdminToken) => (
                  <tr class="border-b border-border/40 last:border-0" classList={{ 'opacity-50': t.revokedAt !== null }}>
                    <td class="px-4 py-2 font-mono text-fg-1">{t.name}</td>
                    <td class="px-4 py-2 text-fg-2">{t.kind}</td>
                    <td class="px-4 py-2">
                      <span
                        class="font-mono text-[11px]"
                        classList={{ 'text-success': t.tier === 'trusted', 'text-warn': t.tier === 'untrusted' }}
                      >
                        {t.tier}
                      </span>
                    </td>
                    <td class="px-4 py-2 font-mono text-[12px] text-fg-2">{wsName(t.workspaceId)}</td>
                    <td class="px-4 py-2 text-fg-3 text-[12px]">{formatRelativeTime(t.createdAt)}</td>
                    <td class="px-4 py-2 text-fg-3 text-[12px]">
                      {t.lastUsedAt !== null ? formatRelativeTime(t.lastUsedAt) : 'never'}
                    </td>
                    <td class="px-4 py-2 text-right">
                      <Show
                        when={t.revokedAt === null}
                        fallback={<span class="text-[11px] text-fg-3">revoked</span>}
                      >
                        <Show when={props.canAdmin}>
                          <button
                            type="button"
                            class="text-[11px] px-2 py-1 rounded border border-border text-danger hover:bg-danger/10 transition"
                            onClick={() => void revoke(t.id)}
                          >
                            Revoke
                          </button>
                        </Show>
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </Card>
    </div>
  )
}

// --- Workspaces -------------------------------------------------------------

function WorkspacesSection(props: { orgId: string; canAdmin: boolean }) {
  const [bump, setBump] = createSignal(0)
  const [list] = createResource(
    () => `${props.orgId}|${bump()}`,
    () => adminListWorkspaces(props.orgId).catch(() => null),
  )
  const [slug, setSlug] = createSignal('')
  const [name, setName] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  async function create(e: Event): Promise<void> {
    e.preventDefault()
    if (busy() || slug().trim() === '') return
    setError(null)
    setBusy(true)
    const r = await adminCreateWorkspace(props.orgId, {
      slug: slug().trim(),
      ...(name().trim() !== '' ? { name: name().trim() } : {}),
    })
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? 'Could not create workspace.')
      return
    }
    setSlug('')
    setName('')
    setBump((v) => v + 1)
    // Refresh the shell's workspace switcher too.
    refreshWorkspaces()
  }

  return (
    <div class="flex flex-col gap-4">
      <Show when={props.canAdmin}>
        <Card title="Create a workspace">
          <p class="text-[12px] text-fg-3 mt-0 mb-3">
            A workspace groups a repo's runs, cache and analytics. CI pushes auto-provision one; create it here to
            mint a workspace-scoped token ahead of the first push.
          </p>
          <form class="flex items-end gap-2 flex-wrap" onSubmit={create}>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] font-medium text-fg-2">Slug</span>
              <input value={slug()} onInput={(e) => setSlug(e.currentTarget.value)} placeholder="my-repo" class="text-[13px] w-40 font-mono" />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] font-medium text-fg-2">Name · optional</span>
              <input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="My Repo" class="text-[13px] w-48" />
            </label>
            <button
              type="submit"
              disabled={busy() || slug().trim() === ''}
              class="px-3.5 py-2 rounded-lg bg-accent text-bg font-medium text-[13px] hover:brightness-110 transition disabled:opacity-50"
            >
              Create
            </button>
          </form>
          <Show when={error()}>
            <div class="mt-3">
              <Notice kind="error">{error()}</Notice>
            </div>
          </Show>
        </Card>
      </Show>

      <Card title="Workspaces" noPad>
        <Show
          when={(list() ?? []).length > 0}
          fallback={<EmptyState title="No workspaces yet" hint="They're auto-provisioned on the first CI push, or create one above." />}
        >
          <table class="w-full text-[13px]" data-testid="workspaces-table">
            <thead>
              <tr class="text-left text-[10px] uppercase tracking-wider text-fg-3 border-b border-border/70">
                <th class="px-4 py-2 font-semibold">Slug</th>
                <th class="px-4 py-2 font-semibold">Name</th>
                <th class="px-4 py-2 font-semibold">ID</th>
                <th class="px-4 py-2 font-semibold">Created</th>
              </tr>
            </thead>
            <tbody>
              <For each={list() ?? []}>
                {(w: AdminWorkspace) => (
                  <tr class="border-b border-border/40 last:border-0">
                    <td class="px-4 py-2 font-mono text-fg-1">{w.slug}</td>
                    <td class="px-4 py-2 text-fg-2">{w.name}</td>
                    <td class="px-4 py-2 font-mono text-[11px] text-fg-3">{w.id}</td>
                    <td class="px-4 py-2 text-fg-3 text-[12px]">{formatRelativeTime(w.createdAt)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </Card>
    </div>
  )
}

// --- Settings ---------------------------------------------------------------

function SettingsSection(props: { orgId: string; canAdmin: boolean; instanceAdmin: boolean }) {
  const orgs = getOrgsSignal()
  const current = () => orgs().find((o) => o.id === props.orgId)
  const [name, setName] = createSignal('')
  const [slug, setSlug] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [notice, setNotice] = createSignal<{ kind: 'error' | 'ok'; msg: string } | null>(null)

  // Re-seed the edit fields from the selected org (and on an org switch) so a
  // Save never carries the previous org's name/slug into the new one.
  createEffect(
    on([() => props.orgId, orgs], () => {
      const c = current()
      setName(c?.name ?? '')
      setSlug(c?.slug ?? '')
      setNotice(null)
    }),
  )

  async function save(e: Event): Promise<void> {
    e.preventDefault()
    if (busy()) return
    setNotice(null)
    setBusy(true)
    const r = await adminUpdateOrg(props.orgId, { name: name().trim(), slug: slug().trim() })
    setBusy(false)
    if (!r.ok) {
      setNotice({ kind: 'error', msg: r.error ?? 'Could not update org.' })
      return
    }
    setNotice({ kind: 'ok', msg: 'Saved.' })
    await refreshOrgs()
  }

  // New-org form (instance admin only).
  const [newSlug, setNewSlug] = createSignal('')
  const [newName, setNewName] = createSignal('')
  const [orgBusy, setOrgBusy] = createSignal(false)
  const [orgNotice, setOrgNotice] = createSignal<{ kind: 'error' | 'ok'; msg: string } | null>(null)

  async function createOrg(e: Event): Promise<void> {
    e.preventDefault()
    if (orgBusy() || newSlug().trim() === '') return
    setOrgNotice(null)
    setOrgBusy(true)
    const r = await adminCreateOrg(newSlug().trim(), newName().trim() || undefined)
    setOrgBusy(false)
    if (!r.ok) {
      setOrgNotice({ kind: 'error', msg: r.error ?? 'Could not create org.' })
      return
    }
    setNewSlug('')
    setNewName('')
    setOrgNotice({ kind: 'ok', msg: 'Organization created.' })
    await refreshOrgs()
  }

  return (
    <div class="flex flex-col gap-4">
      <Card title="Organization">
        <Show when={props.canAdmin} fallback={<Notice kind="error">Only an org admin or owner can edit settings.</Notice>}>
          <form class="flex items-end gap-2 flex-wrap" onSubmit={save}>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] font-medium text-fg-2">Name</span>
              <input value={name()} onInput={(e) => setName(e.currentTarget.value)} class="text-[13px] w-56" />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] font-medium text-fg-2">Slug</span>
              <input value={slug()} onInput={(e) => setSlug(e.currentTarget.value)} class="text-[13px] w-40 font-mono" />
            </label>
            <button
              type="submit"
              disabled={busy()}
              class="px-3.5 py-2 rounded-lg bg-accent text-bg font-medium text-[13px] hover:brightness-110 transition disabled:opacity-50"
            >
              Save
            </button>
          </form>
          <div class="mt-3 text-[11px] text-fg-3 font-mono">org id: {props.orgId}</div>
          <Show when={notice()}>
            {(n) => (
              <div class="mt-3">
                <Notice kind={n().kind}>{n().msg}</Notice>
              </div>
            )}
          </Show>
        </Show>
      </Card>

      <Show when={props.instanceAdmin}>
        <Card title="Create an organization">
          <p class="text-[12px] text-fg-3 mt-0 mb-3">Instance admins provision new organizations. You become its owner.</p>
          <form class="flex items-end gap-2 flex-wrap" onSubmit={createOrg}>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] font-medium text-fg-2">Slug</span>
              <input value={newSlug()} onInput={(e) => setNewSlug(e.currentTarget.value)} placeholder="acme" class="text-[13px] w-40 font-mono" />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] font-medium text-fg-2">Name · optional</span>
              <input value={newName()} onInput={(e) => setNewName(e.currentTarget.value)} placeholder="Acme Inc" class="text-[13px] w-48" />
            </label>
            <button
              type="submit"
              disabled={orgBusy() || newSlug().trim() === ''}
              class="px-3.5 py-2 rounded-lg bg-accent text-bg font-medium text-[13px] hover:brightness-110 transition disabled:opacity-50"
            >
              Create org
            </button>
          </form>
          <Show when={orgNotice()}>
            {(n) => (
              <div class="mt-3">
                <Notice kind={n().kind}>{n().msg}</Notice>
              </div>
            )}
          </Show>
        </Card>
      </Show>
    </div>
  )
}
