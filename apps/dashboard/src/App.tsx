import type { Component } from 'solid-js'

export const App: Component = () => (
  <div class="min-h-screen flex flex-col">
    <header class="border-b border-border bg-bg-elevated px-6 py-4 flex items-center gap-4">
      <h1 class="text-fg font-semibold text-lg tracking-tight">vzn</h1>
      <span class="text-fg-subtle text-sm font-mono">dashboard</span>
    </header>
    <main class="flex-1 px-6 py-8">
      <p class="text-fg-muted">Dashboard scaffold. Pages land in PR #27.</p>
    </main>
  </div>
)
