// `<vx-setting-source>`: the workspace page's "who wins" ladder for one
// setting, `run.timeout`. The reader switches each place a value can come
// from on or off; the element marks the first rung set, top down, as vx
// reads them, and says the limit the task gets. The static markup is the
// ladder with every rung on.

class SettingSource extends HTMLElement {
  connectedCallback() {
    this.addEventListener('click', (e) => {
      const rung = (e.target as Element).closest<HTMLButtonElement>('button[data-value]')
      if (rung === null) return
      rung.setAttribute('aria-pressed', String(rung.getAttribute('aria-pressed') !== 'true'))
      this.#show()
    })
    this.#show()
  }

  #show() {
    const rungs = [...this.querySelectorAll<HTMLButtonElement>('button[data-value]')]
    const winner = rungs.find((r) => r.getAttribute('aria-pressed') === 'true')
    for (const r of rungs) {
      const on = r.getAttribute('aria-pressed') === 'true'
      r.classList.toggle('is-ok', r === winner)
      r.classList.toggle('is-muted', !on)
      r.querySelector('.state')!.textContent =
        r === winner ? ' ✓ wins' : on ? ' · overridden' : ' · not set'
    }
    this.querySelector<HTMLElement>('.vx-say')!.innerHTML =
      winner === undefined
        ? `<code>@demo/web#build</code> runs with <strong>no time limit</strong> (the default)`
        : `<code>@demo/web#build</code> gets <strong class="is-ok">${winner.dataset['value']}</strong>, from <code>${winner.dataset['from']}</code>`
  }
}

customElements.define('vx-setting-source', SettingSource)
