import type { ParentComponent } from 'solid-js'
import { A } from '@solidjs/router'

export const Shell: ParentComponent = (props) => {
  return (
    <div class="min-h-full flex flex-col">
      <header class="border-b border-border-muted bg-bg-elevated">
        <div class="flex items-center gap-6 px-6 h-12 max-w-7xl mx-auto">
          <A href="/" class="font-mono font-bold text-accent text-base no-underline">
            vx insights
          </A>
          <nav class="flex gap-4">
            <A
              href="/"
              end={true}
              class="text-fg-muted hover:text-fg no-underline text-sm"
              activeClass="text-fg"
            >
              Overview
            </A>
          </nav>
        </div>
      </header>
      <main class="flex-1 px-6 py-6 max-w-7xl mx-auto w-full">{props.children}</main>
      <footer class="border-t border-border-muted text-fg-muted text-xs px-6 py-3 text-center">
        Read-only client-side analytics over your local <code class="font-mono">cache.db</code>.
      </footer>
    </div>
  )
}
