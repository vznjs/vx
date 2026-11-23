// `<vx-run-timeline>`: enhances `RunTimeline.astro`. The controls change the
// run; each change replays it, bars filling in time order over about two
// seconds, or at once under reduced motion.
import { commandHtml, renderRun, sentence, simulate, type Options } from './model/run-timeline.js'

const PLAY_MS = 2000

class RunTimeline extends HTMLElement {
  #opts: Options = { concurrency: 2, failFast: false }
  #timers: Array<ReturnType<typeof setTimeout>> = []

  connectedCallback() {
    const fail = this.dataset['fail']
    this.#opts = {
      concurrency: Number(this.dataset['concurrency']),
      fail: fail === '' ? undefined : fail,
      failFast: false,
    }
    this.querySelector<HTMLElement>('.controls')!.hidden = false
    this.addEventListener('click', (e) => {
      const b = (e.target as Element).closest('button')
      if (b === null) return
      const o = this.#opts
      if (b.matches('.less')) o.concurrency = Math.max(1, o.concurrency - 1)
      else if (b.matches('.more')) o.concurrency = Math.min(4, o.concurrency + 1)
      else if (b.matches('.fail-fast')) o.failFast = !o.failFast
      else if (b.matches('.pick')) o.fail = b.dataset['fail'] || undefined
      else if (!b.matches('.run')) return
      this.#draw()
    })
    this.#sync()
  }

  #sync() {
    const o = this.#opts
    this.querySelector('.slots')!.textContent = String(o.concurrency)
    this.querySelector<HTMLButtonElement>('.less')!.disabled = o.concurrency === 1
    this.querySelector<HTMLButtonElement>('.more')!.disabled = o.concurrency === 4
    this.querySelector('.fail-fast')!.setAttribute('aria-pressed', String(o.failFast))
    for (const b of this.querySelectorAll<HTMLElement>('.pick'))
      b.setAttribute('aria-pressed', String((b.dataset['fail'] || undefined) === o.fail))
  }

  #draw() {
    this.#sync()
    const run = simulate(this.#opts)
    this.querySelector('.cmd .line')!.innerHTML = commandHtml(this.#opts)
    this.querySelector('.view')!.innerHTML = renderRun(run, this.#opts)
    const say = this.querySelector('.say')!
    for (const t of this.#timers.splice(0)) clearTimeout(t)
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.classList.remove('playing')
      say.textContent = sentence(run, this.#opts)
      return
    }
    say.textContent = ''
    this.classList.add('playing')
    const perUnit = PLAY_MS / Math.max(run.end, 1)
    const fills = [...this.querySelectorAll<HTMLElement>('.bar')].map((bar) => {
      const fill = bar.querySelector<HTMLElement>('.fill')!
      const name = bar.querySelector<HTMLElement>('.name')!
      fill.style.transform = 'scaleX(0)'
      name.style.opacity = '0'
      // Running, it wears no outcome yet: a reader learns it as vx does, at its end.
      bar.classList.add('running')
      return { bar, fill, name }
    })
    // One reflow so the bars start empty before their transitions begin.
    void this.offsetWidth
    for (const { bar, fill, name } of fills) {
      const start = Number(bar.dataset['start']) * perUnit
      const units = Number(bar.dataset['units']) * perUnit
      fill.style.transition = `transform ${units}ms linear ${start}ms`
      fill.style.transform = ''
      name.style.transition = `opacity 150ms linear ${start}ms`
      name.style.opacity = ''
      this.#timers.push(setTimeout(() => bar.classList.remove('running'), start + units))
    }
    this.#timers.push(
      setTimeout(() => {
        this.classList.remove('playing')
        say.textContent = sentence(run, this.#opts)
      }, PLAY_MS),
    )
  }
}

customElements.define('vx-run-timeline', RunTimeline)
