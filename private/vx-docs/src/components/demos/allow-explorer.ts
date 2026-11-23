// `<vx-allow-explorer>`: enhances `AllowExplorer.astro`. Shows the row of
// runs and one case at a time; without it, every case stays stacked.

class AllowExplorer extends HTMLElement {
  connectedCallback() {
    const row = this.querySelector<HTMLElement>('.vx-row')!
    row.hidden = false
    const show = (id: string) => {
      for (const c of this.querySelectorAll<HTMLElement>('[data-case]'))
        c.hidden = c.dataset['case'] !== id
      for (const b of this.querySelectorAll<HTMLButtonElement>('[data-pick]'))
        b.setAttribute('aria-pressed', String(b.dataset['pick'] === id))
    }
    row.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLButtonElement>('[data-pick]')
      if (b !== null) show(b.dataset['pick']!)
    })
    show(this.querySelector<HTMLButtonElement>('[data-pick]')!.dataset['pick']!)
  }
}

customElements.define('vx-allow-explorer', AllowExplorer)
