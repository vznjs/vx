// `<vx-run-picker>`: enhances `RunPicker.astro`. The reader picks a task
// and how to select projects; the element draws which tasks that
// `vx run` starts in the demo workspace, and which run first because
// another waits on them.
import {
  PROJECTS,
  USES,
  command,
  plan,
  type Project,
  type Scope,
  type Task,
} from './model/run-picker.js'

type Mode = 'here' | 'all' | 'filter' | 'affected'

class RunPicker extends HTMLElement {
  #task: Task = 'build'
  #mode: Mode = 'here'
  #changed = new Set<Project>(['@demo/ui'])

  connectedCallback() {
    for (const el of this.querySelectorAll<HTMLElement>('[data-js]')) el.hidden = false
    // Removed, not hidden: the widget kit's `table { display: block }` beats `hidden`.
    this.querySelector('.js-hint')!.remove()
    this.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLButtonElement>('button')
      if (b === null) return
      const { task, mode, preset, changed } = b.dataset
      if (task !== undefined) this.#task = task as Task
      if (mode !== undefined) this.#mode = mode as Mode
      if (preset !== undefined) {
        this.#mode = 'filter'
        this.#input().value = preset
      }
      if (changed !== undefined) {
        const p = changed as Project
        if (this.#changed.has(p)) this.#changed.delete(p)
        else this.#changed.add(p)
      }
      this.#draw()
    })
    this.#input().addEventListener('input', () => this.#draw())
    this.#draw()
  }

  #input = () => this.querySelector<HTMLInputElement>('.filter')!

  #scope(): Scope {
    if (this.#mode === 'here') return { kind: 'here', project: '@demo/web' }
    if (this.#mode === 'all') return { kind: 'all' }
    if (this.#mode === 'affected') return { kind: 'affected', changed: [...this.#changed] }
    const filters = this.#input()
      .value.split(/\s+/)
      .filter((f) => f !== '')
    return { kind: 'filter', filters }
  }

  #draw() {
    for (const b of this.querySelectorAll<HTMLButtonElement>('button[data-task]'))
      b.setAttribute('aria-pressed', String(b.dataset['task'] === this.#task))
    for (const b of this.querySelectorAll<HTMLButtonElement>('button[data-mode]'))
      b.setAttribute('aria-pressed', String(b.dataset['mode'] === this.#mode))
    for (const b of this.querySelectorAll<HTMLButtonElement>('button[data-changed]'))
      b.setAttribute('aria-pressed', String(this.#changed.has(b.dataset['changed'] as Project)))
    this.querySelector<HTMLElement>('.filter-row')!.hidden = this.#mode !== 'filter'
    this.querySelector<HTMLElement>('.changed-row')!.hidden = this.#mode !== 'affected'

    const scope = this.#scope()
    const where = this.#mode === 'here' ? 'packages/web $ ' : '$ '
    this.querySelector<HTMLElement>('.cmd')!.textContent = where + command(this.#task, scope)

    const p = plan(this.#task, scope)
    const role = new Map(p.tasks.map((t) => [t.id, t.role]))
    for (const card of this.querySelectorAll<HTMLElement>('[data-project]')) {
      const project = card.dataset['project'] as Project
      const changed = this.#mode === 'affected' && this.#changed.has(project)
      card.classList.toggle('is-changed', changed)
      let any = false
      for (const chip of card.querySelectorAll<HTMLElement>('[data-id]')) {
        const r = role.get(chip.dataset['id']!)
        chip.dataset['role'] = r ?? 'idle'
        if (r !== undefined) any = true
      }
      card.classList.toggle('is-idle', !any)
    }

    const say = this.querySelector<HTMLElement>('.vx-say')!
    if (p.error !== undefined) {
      say.innerHTML = `<span class="is-danger">✗ vx run</span> ${escape(p.error)}. Nothing runs.`
      return
    }
    const first = p.tasks.filter((t) => t.role === 'first').map((t) => t.id)
    const asked = p.tasks.length - first.length
    let text = asked === 0 ? 'Nothing to run.' : `${count(p.tasks.length)} run.`
    if (first.length > 0) {
      const waiters = PROJECTS.filter((q) => USES[q].length > 0 && role.has(`${q}#${this.#task}`))
      text += ` <code>${first.join('</code>, <code>')}</code> goes first: ${waiters
        .map((w) => `<code>${w}</code>`)
        .join(' and ')} wait${waiters.length === 1 ? 's' : ''} on it.`
    }
    say.innerHTML = text
  }
}

const count = (n: number) => (n === 1 ? '1 task' : `${n} tasks`)
const escape = (s: string) => s.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)

customElements.define('vx-run-picker', RunPicker)
