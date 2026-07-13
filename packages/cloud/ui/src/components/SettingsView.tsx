// `/settings` — the personal account hub: Profile (rename) and Security
// (change password), backed by PATCH /v1/auth/me and POST /v1/auth/password.
// Organization administration lives in its own area (/admin); privileged users
// get a link out. A left sub-nav switches sections, SaaS-settings style.

import { createMemo, createSignal, Show, type JSX } from 'solid-js'
import { A } from '@solidjs/router'
import { changePassword, getCurrentUserSignal, updateProfile } from '../api.ts'
import { Card } from './ui.tsx'

type Tab = 'profile' | 'security'

export function SettingsView() {
  const user = getCurrentUserSignal()
  const [tab, setTab] = createSignal<Tab>('profile')
  const canSeeAdmin = createMemo(() => {
    const u = user()
    if (u === null) return false
    return u.instanceAdmin || u.orgs.some((o) => o.role === 'admin' || o.role === 'owner')
  })

  return (
    <div class="max-w-4xl mx-auto">
      <div class="mb-5">
        <h1 class="text-lg font-semibold m-0 tracking-tight">Settings</h1>
        <p class="text-fg-3 text-[12px] m-0 mt-0.5">Manage your account.</p>
      </div>
      <div class="flex flex-col sm:flex-row gap-6">
        {/* Sub-nav */}
        <nav class="sm:w-48 shrink-0 flex sm:flex-col gap-1">
          <TabButton active={tab() === 'profile'} icon="i-tabler-user" onClick={() => setTab('profile')}>
            Profile
          </TabButton>
          <TabButton active={tab() === 'security'} icon="i-tabler-lock" onClick={() => setTab('security')}>
            Security
          </TabButton>
          <Show when={canSeeAdmin()}>
            <A
              href="/admin"
              class="flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] text-fg-2 hover:text-fg hover:bg-surface-hover/70 transition-all no-underline"
            >
              <span class="i-tabler-shield-lock text-base shrink-0 opacity-80" aria-hidden="true" />
              <span>Organization</span>
              <span class="i-tabler-external-link text-[12px] ml-auto opacity-60" aria-hidden="true" />
            </A>
          </Show>
        </nav>

        {/* Content */}
        <div class="flex-1 min-w-0 flex flex-col gap-5">
          <Show when={tab() === 'profile'}>
            <ProfileSection />
          </Show>
          <Show when={tab() === 'security'}>
            <SecuritySection />
          </Show>
        </div>
      </div>
    </div>
  )
}

function TabButton(props: { active: boolean; icon: string; onClick: () => void; children: JSX.Element }) {
  return (
    <button
      onClick={props.onClick}
      class="flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] transition-all text-left"
      classList={{
        'text-accent bg-accent/10 font-medium ring-1 ring-inset ring-accent/20': props.active,
        'text-fg-2 hover:text-fg hover:bg-surface-hover/70': !props.active,
      }}
    >
      <span class={`${props.icon} text-base shrink-0 opacity-80`} aria-hidden="true" />
      <span>{props.children}</span>
    </button>
  )
}

/** A dismissable inline result banner (success or error). */
function Banner(props: { kind: 'ok' | 'err'; children: JSX.Element }) {
  return (
    <div
      class="rounded-lg px-3 py-2 text-[12px] flex items-center gap-2"
      classList={{
        'border border-success/40 bg-success/5 text-success': props.kind === 'ok',
        'border border-danger/40 bg-danger/5 text-danger': props.kind === 'err',
      }}
    >
      <span
        class={props.kind === 'ok' ? 'i-tabler-circle-check' : 'i-tabler-alert-circle'}
        aria-hidden="true"
      />
      {props.children}
    </div>
  )
}

function Field(props: { label: string; hint?: string; children: JSX.Element }) {
  return (
    <label class="block">
      <span class="block text-[12px] text-fg-2 font-medium mb-1.5">{props.label}</span>
      {props.children}
      <Show when={props.hint}>
        <span class="block text-[11px] text-fg-3 mt-1">{props.hint}</span>
      </Show>
    </label>
  )
}

function ProfileSection() {
  const user = getCurrentUserSignal()
  const [name, setName] = createSignal(user()?.displayName ?? '')
  const [busy, setBusy] = createSignal(false)
  const [result, setResult] = createSignal<{ kind: 'ok' | 'err'; msg: string } | null>(null)

  const dirty = () => name().trim() !== '' && name().trim() !== (user()?.displayName ?? '')

  async function save(e: Event) {
    e.preventDefault()
    if (!dirty() || busy()) return
    setBusy(true)
    setResult(null)
    const r = await updateProfile(name().trim())
    setBusy(false)
    setResult(r.ok ? { kind: 'ok', msg: 'Profile updated.' } : { kind: 'err', msg: r.error ?? 'Update failed.' })
  }

  return (
    <Card title="Profile">
      <form class="flex flex-col gap-4" onSubmit={save}>
        <Field label="Display name">
          <input
            type="text"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            maxLength={200}
            class="w-full max-w-md text-[13px]"
            placeholder="Your name"
          />
        </Field>
        <Field label="Email" hint="Your sign-in identity — contact an admin to change it.">
          <input type="email" value={user()?.email ?? ''} disabled class="w-full max-w-md text-[13px] opacity-70" />
        </Field>
        <Show when={result()}>{(r) => <Banner kind={r().kind}>{r().msg}</Banner>}</Show>
        <div>
          <button
            type="submit"
            disabled={!dirty() || busy()}
            class="px-3.5 py-2 rounded-lg bg-accent text-bg font-medium text-[13px] hover:brightness-110 transition disabled:opacity-50"
          >
            {busy() ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </Card>
  )
}

function SecuritySection() {
  const [current, setCurrent] = createSignal('')
  const [next, setNext] = createSignal('')
  const [confirm, setConfirm] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [result, setResult] = createSignal<{ kind: 'ok' | 'err'; msg: string } | null>(null)

  const mismatch = () => confirm() !== '' && next() !== confirm()
  const valid = () => current() !== '' && next().length >= 8 && next() === confirm()

  async function save(e: Event) {
    e.preventDefault()
    if (!valid() || busy()) return
    setBusy(true)
    setResult(null)
    const r = await changePassword(current(), next())
    setBusy(false)
    if (r.ok) {
      setCurrent('')
      setNext('')
      setConfirm('')
      setResult({ kind: 'ok', msg: 'Password changed.' })
    } else {
      setResult({ kind: 'err', msg: r.error ?? 'Could not change password.' })
    }
  }

  return (
    <Card title="Change password">
      <form class="flex flex-col gap-4" onSubmit={save}>
        <Field label="Current password">
          <input
            type="password"
            value={current()}
            onInput={(e) => setCurrent(e.currentTarget.value)}
            autocomplete="current-password"
            class="w-full max-w-md text-[13px]"
          />
        </Field>
        <Field label="New password" hint="At least 8 characters.">
          <input
            type="password"
            value={next()}
            onInput={(e) => setNext(e.currentTarget.value)}
            autocomplete="new-password"
            class="w-full max-w-md text-[13px]"
          />
        </Field>
        <Field label="Confirm new password">
          <input
            type="password"
            value={confirm()}
            onInput={(e) => setConfirm(e.currentTarget.value)}
            autocomplete="new-password"
            class="w-full max-w-md text-[13px]"
          />
        </Field>
        <Show when={mismatch()}>
          <Banner kind="err">The new passwords don't match.</Banner>
        </Show>
        <Show when={result()}>{(r) => <Banner kind={r().kind}>{r().msg}</Banner>}</Show>
        <div>
          <button
            type="submit"
            disabled={!valid() || busy()}
            class="px-3.5 py-2 rounded-lg bg-accent text-bg font-medium text-[13px] hover:brightness-110 transition disabled:opacity-50"
          >
            {busy() ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </form>
    </Card>
  )
}
