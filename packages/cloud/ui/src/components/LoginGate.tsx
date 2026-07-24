// Full-screen authentication gate (cloud-platform-2026-07 §6). Shown whenever
// the dashboard has no session. The platform is invite-only after the FIRST
// account (which becomes the instance admin), so this offers Sign in + Create
// account; an invite token on the register form onboards an invited user into
// their org. There is no separate token entry — the platform authenticates
// with a session cookie, resolved by api.ts.

import { Show, createResource, createSignal } from 'solid-js'
import {
  getMeta,
  getOrigin,
  getOriginSignal,
  login,
  register,
  setOriginAndPersist,
} from '../api.ts'
import { StatusDot } from './ui.tsx'

type Mode = 'login' | 'register'

export function LoginGate() {
  const originSig = getOriginSignal()
  const [meta] = createResource(originSig, () => getMeta().catch(() => null))
  const [mode, setMode] = createSignal<Mode>('login')
  const [email, setEmail] = createSignal('')
  const [password, setPassword] = createSignal('')
  const [displayName, setDisplayName] = createSignal('')
  const [invite, setInvite] = createSignal(readInviteFromUrl())
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  // A ?invite= in the launch URL flips straight to the register form.
  if (invite() !== '') setMode('register')

  const [editingServer, setEditingServer] = createSignal(false)
  const [serverDraft, setServerDraft] = createSignal(getOrigin())

  async function submit(e: Event) {
    e.preventDefault()
    if (busy()) return
    setError(null)
    setBusy(true)
    try {
      const r =
        mode() === 'login'
          ? await login(email().trim(), password())
          : await register({
              email: email().trim(),
              password: password(),
              displayName: displayName().trim(),
              invite: invite().trim(),
            })
      if (!r.ok) setError(r.error ?? 'Something went wrong.')
      // On success api.ts flips authState → the app mounts; nothing to do here.
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="min-h-screen flex items-center justify-center bg-bg p-6">
      <div class="w-full max-w-sm">
        <div class="flex items-center gap-2.5 justify-center mb-6">
          <div class="w-9 h-9 rounded-xl bg-gradient-to-br from-accent to-accent-2 flex items-center justify-center text-bg font-bold text-sm shadow-glow">
            vx
          </div>
          <span class="font-mono text-lg text-fg-1 font-semibold tracking-tight">vx cloud</span>
        </div>

        <div class="bg-surface/80 border border-border rounded-2xl shadow-elevated backdrop-blur-sm overflow-hidden">
          {/* Server identity */}
          <div class="px-5 py-3 border-b border-border/70 flex items-center gap-2 text-[11px] font-mono">
            <StatusDot ok={meta() !== null && meta() !== undefined} />
            <Show
              when={meta()}
              fallback={<span class="text-fg-3">{getOrigin().replace(/^https?:\/\//, '')}</span>}
            >
              {(m) => (
                <>
                  <span class="text-fg-1 font-medium">{m().name}</span>
                  <span class="text-fg-3">· {getOrigin().replace(/^https?:\/\//, '')}</span>
                </>
              )}
            </Show>
            <button
              type="button"
              class="ml-auto text-fg-3 hover:text-fg text-[11px]"
              onClick={() => {
                setServerDraft(getOrigin())
                setEditingServer((v) => !v)
              }}
            >
              change
            </button>
          </div>

          <Show when={editingServer()}>
            <form
              class="px-5 py-3 border-b border-border/70 flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                setOriginAndPersist(serverDraft())
                setEditingServer(false)
              }}
            >
              <input
                type="url"
                value={serverDraft()}
                onInput={(e) => setServerDraft(e.currentTarget.value)}
                placeholder="https://vx.acme.dev"
                class="flex-1 text-[12px] font-mono"
              />
              <button type="submit" class="text-[11px] px-2 py-1 rounded border border-accent text-accent hover:bg-accent hover:text-bg transition">
                set
              </button>
            </form>
          </Show>

          {/* Tabs */}
          <div class="flex text-[13px] border-b border-border/70">
            <TabButton active={mode() === 'login'} onClick={() => { setMode('login'); setError(null) }}>
              Sign in
            </TabButton>
            <TabButton active={mode() === 'register'} onClick={() => { setMode('register'); setError(null) }}>
              Create account
            </TabButton>
          </div>

          <form class="p-5 flex flex-col gap-3" onSubmit={submit}>
            <Field label="Email">
              <input
                type="email"
                autocomplete="email"
                required
                value={email()}
                onInput={(e) => setEmail(e.currentTarget.value)}
                class="w-full text-[13px]"
                placeholder="you@example.com"
              />
            </Field>
            <Field label="Password">
              <input
                type="password"
                autocomplete={mode() === 'login' ? 'current-password' : 'new-password'}
                required
                minLength={8}
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
                class="w-full text-[13px]"
                placeholder={mode() === 'register' ? 'at least 8 characters' : '••••••••'}
              />
            </Field>

            <Show when={mode() === 'register'}>
              <Field label="Display name" hint="optional">
                <input
                  type="text"
                  autocomplete="name"
                  value={displayName()}
                  onInput={(e) => setDisplayName(e.currentTarget.value)}
                  class="w-full text-[13px]"
                  placeholder="Ada Lovelace"
                />
              </Field>
              <Field label="Invite token" hint="required unless you're the first user">
                <input
                  type="text"
                  value={invite()}
                  onInput={(e) => setInvite(e.currentTarget.value)}
                  class="w-full text-[12px] font-mono"
                  placeholder="vxi_…"
                />
              </Field>
            </Show>

            <Show when={error()}>
              <div class="rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-[12px] text-danger" data-testid="auth-error">
                {error()}
              </div>
            </Show>

            <button
              type="submit"
              disabled={busy()}
              class="mt-1 w-full flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-lg bg-accent text-bg font-medium text-[13px] hover:brightness-110 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Show when={busy()}>
                <span class="i-tabler-loader-2 animate-spin" aria-hidden="true" />
              </Show>
              {mode() === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>
        </div>

        <p class="text-center text-[11px] text-fg-3 mt-4">
          <Show
            when={mode() === 'login'}
            fallback={<>The very first account becomes the instance admin. Otherwise an invite is required.</>}
          >
            A self-hosted vx cloud platform. No account?{' '}
            <button class="text-accent hover:underline" onClick={() => setMode('register')}>
              create one
            </button>
            .
          </Show>
        </p>
      </div>
    </div>
  )
}

function TabButton(props: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class="flex-1 py-2.5 font-medium transition"
      classList={{
        'text-accent border-b-2 border-accent -mb-px': props.active,
        'text-fg-3 hover:text-fg-2': !props.active,
      }}
    >
      {props.children}
    </button>
  )
}

function Field(props: { label: string; hint?: string; children: unknown }) {
  return (
    <label class="flex flex-col gap-1">
      <span class="text-[11px] font-medium text-fg-2 flex items-center gap-1.5">
        {props.label}
        <Show when={props.hint}>
          <span class="text-fg-3 font-normal">· {props.hint}</span>
        </Show>
      </span>
      {props.children as never}
    </label>
  )
}

/** A ?invite=… on the launch URL (hash-router friendly) pre-fills the form. */
function readInviteFromUrl(): string {
  if (typeof window === 'undefined') return ''
  try {
    const direct = new URL(window.location.href).searchParams.get('invite')
    if (direct !== null && direct !== '') return direct
    // Hash-router deep link: #/whatever?invite=…
    const hash = window.location.hash
    const q = hash.indexOf('?')
    if (q >= 0) {
      const v = new URLSearchParams(hash.slice(q + 1)).get('invite')
      if (v !== null) return v
    }
  } catch {
    // ignore malformed URL
  }
  return ''
}
