// `<vx-workspace-root>`: the workspace page's "where is the root" tree. The
// reader picks the folder they run vx in; the element walks up from it, as
// vx does, and marks the `.vx/workspace.ts` it stops at, or the git root it
// may not pass. The static markup already shows one answer.

class WorkspaceRoot extends HTMLElement {
  connectedCallback() {
    this.addEventListener('click', (e) => {
      const pick = (e.target as Element).closest<HTMLButtonElement>('button[data-dir]')
      if (pick !== null) this.#walk(pick.dataset['dir']!)
    })
  }

  #walk(from: string) {
    const rows = [...this.querySelectorAll<HTMLButtonElement>('button[data-dir]')]
    const byDir = new Map(rows.map((r) => [r.dataset['dir']!, r]))
    const seen: string[] = []
    let found: string | null = null
    for (let dir: string | null = from; dir !== null; dir = parentDir(dir)) {
      const row = byDir.get(dir)
      if (row === undefined) break
      seen.push(dir)
      if (row.hasAttribute('data-ws')) {
        found = dir
        break
      }
      if (row.hasAttribute('data-git')) break
    }
    for (const r of rows) {
      const dir = r.dataset['dir']!
      r.setAttribute('aria-pressed', String(dir === from))
      r.classList.toggle('is-ok', dir === found)
      r.classList.toggle('is-muted', !seen.includes(dir))
    }
    const say = this.querySelector<HTMLElement>('.vx-say')!
    say.innerHTML =
      found === null
        ? `<span class="is-danger">✗</span> no <code>.vx/workspace.ts</code> up to the git root: vx asks you to run <code>vx init</code>`
        : `<span class="is-ok">✓</span> vx uses <code>${found}/.vx/workspace.ts</code> ${up(seen.length - 1)}`
  }
}

const up = (n: number): string =>
  n === 0 ? 'right where you are' : `${n} folder${n === 1 ? '' : 's'} up`

const parentDir = (dir: string): string | null => {
  const at = dir.lastIndexOf('/')
  return at === -1 ? null : dir.slice(0, at)
}

customElements.define('vx-workspace-root', WorkspaceRoot)
