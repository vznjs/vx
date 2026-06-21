import { createResource, createSignal, Show, type ParentComponent } from 'solid-js'
import { A } from '@solidjs/router'
import { getOrigin, getOriginSignal, getVersion, setOriginAndPersist } from '../api.ts'

export const Shell: ParentComponent = (props) => {
  const origin = getOriginSignal()
  const [version] = createResource(origin, async () => {
    try {
      return await getVersion()
    } catch {
      return null
    }
  })

  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal(getOrigin())

  function commit() {
    setOriginAndPersist(draft())
    setEditing(false)
  }

  return (
    <div class="min-h-full flex flex-col">
      <header class="border-b border-border-muted bg-bg-elevated">
        <div class="flex items-center gap-6 px-6 h-12 max-w-7xl mx-auto">
          <A href="/" class="font-mono font-bold text-accent text-base no-underline">
            vx dashboard
          </A>
          <nav class="flex gap-4 flex-1">
            <A
              href="/"
              end={true}
              class="text-fg-muted hover:text-fg no-underline text-sm"
              activeClass="text-fg"
            >
              Overview
            </A>
            <A
              href="/tasks"
              class="text-fg-muted hover:text-fg no-underline text-sm"
              activeClass="text-fg"
            >
              Tasks
            </A>
            <A
              href="/cache"
              class="text-fg-muted hover:text-fg no-underline text-sm"
              activeClass="text-fg"
            >
              Cache
            </A>
          </nav>
          <Show
            when={editing()}
            fallback={
              <button
                type="button"
                onClick={() => {
                  setDraft(getOrigin())
                  setEditing(true)
                }}
                class="flex items-center gap-2 text-xs font-mono px-2 py-1 rounded border border-border-muted hover:bg-bg cursor-pointer"
                title="Change connection"
              >
                <span
                  class={
                    version()
                      ? 'inline-block w-2 h-2 rounded-full bg-success'
                      : 'inline-block w-2 h-2 rounded-full bg-failure'
                  }
                />
                <span class="text-fg-muted">{origin()}</span>
              </button>
            }
          >
            <form
              onSubmit={(e) => {
                e.preventDefault()
                commit()
              }}
              class="flex items-center gap-1"
            >
              <input
                type="url"
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                placeholder="http://localhost:4321"
                class="text-xs font-mono px-2 py-1 rounded border border-border-muted bg-bg w-60"
                autofocus
              />
              <button
                type="submit"
                class="text-xs px-2 py-1 rounded border border-accent text-accent hover:bg-accent hover:text-bg cursor-pointer"
              >
                connect
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                class="text-xs px-2 py-1 rounded text-fg-muted hover:text-fg cursor-pointer"
              >
                cancel
              </button>
            </form>
          </Show>
        </div>
      </header>
      <main class="flex-1 px-6 py-6 max-w-7xl mx-auto w-full">{props.children}</main>
      <footer class="border-t border-border-muted text-fg-muted text-xs px-6 py-3 text-center">
        <Show
          when={version()}
          fallback={
            <>
              Not connected. Run <code>vx serve</code> in your workspace and paste its origin above.
            </>
          }
        >
          {(v) => (
            <>
              vx {v().vx} · workspace <code class="font-mono">{v().workspace}</code>
            </>
          )}
        </Show>
      </footer>
    </div>
  )
}
