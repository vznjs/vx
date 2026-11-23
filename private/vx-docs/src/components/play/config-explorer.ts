// `<vx-config-explorer>`: enhances `ConfigExplorer.astro`. A key in the
// file, a field inside the panel or a search hit opens that field's panel;
// the fields the file leaves unset fold away until asked for.
import { renderPanel, search, type Row } from './model/config-explorer.js'

class ConfigExplorer extends HTMLElement {
  #rows = new Map<string, Row>()
  #list: Row[] = []

  connectedCallback() {
    this.#list = JSON.parse(this.querySelector('.cx-data')!.textContent!) as Row[]
    this.#rows = new Map(this.#list.map((r) => [r.path, r]))
    this.querySelector<HTMLElement>('.cx-find')!.hidden = false
    for (const b of this.querySelectorAll<HTMLButtonElement>('.cx-fold')) b.hidden = false
    const start = this.dataset['start']!
    // A group the file leaves unset starts folded, unless it holds the open field.
    for (const g of this.querySelectorAll<HTMLElement>('.cx-group')) {
      const open = g.previousElementSibling!
      if (open.classList.contains('is-off') && !start.startsWith(`${g.dataset['group']}.`))
        this.#fold(g, false)
    }
    this.#scrollTo(start)

    this.addEventListener('click', (e) => {
      const t = e.target as Element
      const fold = t.closest<HTMLButtonElement>('.cx-fold')
      if (fold !== null) {
        const g = fold.closest('.cx-line')!.nextElementSibling as HTMLElement
        return this.#fold(g, g.hidden === true)
      }
      const pick = t.closest<HTMLElement>('[data-path]')
      if (pick !== null) this.#open(pick.dataset['path']!, !pick.classList.contains('cx-key'))
    })
    const q = this.querySelector<HTMLInputElement>('.cx-q')!
    q.addEventListener('input', () => this.#find(q.value))
    q.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      const first = search(this.#list, q.value)[0]
      if (first !== undefined) this.#open(first, true)
    })
  }

  #fold(group: HTMLElement, open: boolean) {
    group.hidden = !open
    const line = group.previousElementSibling!
    line.querySelector<HTMLElement>('.cx-more')!.hidden = open
    const b = line.querySelector<HTMLButtonElement>('.cx-fold')!
    b.setAttribute('aria-expanded', String(open))
    const key = line.querySelector('.cx-key')!.textContent
    b.setAttribute('aria-label', `${open ? 'Fold' : 'Unfold'} ${key}`)
  }

  #find(text: string) {
    const hits = this.querySelector<HTMLElement>('.cx-hits')!
    const found = search(this.#list, text)
    hits.replaceChildren(
      ...found.map((p) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.dataset['path'] = p
        b.textContent = this.#rows.get(p)!.shown
        return b
      }),
    )
    hits.hidden = found.length === 0
    this.#say(
      text.trim() === ''
        ? ''
        : found.length === 0
          ? `No field matches “${text.trim()}”.`
          : `${found.length === 8 ? '8 or more' : found.length} field${found.length === 1 ? '' : 's'} match.`,
    )
  }

  #say(text: string) {
    this.querySelector<HTMLElement>('.cx-say')!.textContent = text
  }

  #open(path: string, scroll: boolean) {
    const row = this.#rows.get(path)!
    for (const k of this.querySelectorAll<HTMLElement>('.cx-key')) {
      const on = k.dataset['path'] === path
      k.setAttribute('aria-pressed', String(on))
      k.closest('.cx-line')!.classList.toggle('is-on', on)
    }
    // Its own group opens too: a group's panel lists what is inside.
    for (const g of this.querySelectorAll<HTMLElement>('.cx-group')) {
      const holds = path === g.dataset['group'] || path.startsWith(`${g.dataset['group']}.`)
      if (holds && g.hidden === true) this.#fold(g, true)
    }
    const panel = this.querySelector<HTMLElement>('.cx-panel')!
    panel.innerHTML = renderPanel(row)
    this.#say(`Showing ${row.shown}.`)
    if (scroll) {
      this.#scrollTo(path)
      // Focus follows to the key, so Tab moves on from where the reader is.
      this.#key(path)?.focus({ preventScroll: true })
    }
    // On a phone the panel sits under the file: bring it into view.
    if (matchMedia('(max-width: 52rem)').matches) {
      const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches
      panel.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' })
    }
  }

  #key = (path: string) =>
    [...this.querySelectorAll<HTMLElement>('.cx-key')].find((k) => k.dataset['path'] === path)

  /** Scroll the file's own box, never the page, to a field's line. */
  #scrollTo(path: string) {
    const box = this.querySelector<HTMLElement>('.cx-src')!
    const key = this.#key(path)
    if (key === undefined) return
    const line = key.closest<HTMLElement>('.cx-line')!
    box.scrollTop = Math.max(0, line.offsetTop - box.clientHeight / 3)
  }
}

customElements.define('vx-config-explorer', ConfigExplorer)
