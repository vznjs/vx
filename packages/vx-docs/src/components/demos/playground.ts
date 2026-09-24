// `<vx-playground>`: enhances the static workspace `Playground.astro`
// renders. It unhides a file editor, the env and task-spec fields and Run
// and Reset, and hides the static render. The planner, vx's own, is
// imported from the site on the first Run, so a page view that never runs
// costs nothing. What a run computes is `model/playground-view.ts`; this
// only wires it to the markup.
import { ENV, FILES, TASKS } from '../../playground/workspace.js'
import {
  changeCell,
  diffRuns,
  envText,
  failureSummary,
  orderLine,
  parseEnv,
  parseTasks,
  runPlayground,
  summarize,
  type Planner,
  type PlaygroundTask,
} from './model/playground-view.js'

const firstFile = (files: Record<string, string>): string | undefined => Object.keys(files)[0]

class Playground extends HTMLElement {
  #files: Record<string, string> = { ...FILES }
  #selected: string | undefined = firstFile(FILES)
  #cached = new Set<string>()
  #last: PlaygroundTask[] | undefined
  #planner: Promise<Planner> | undefined
  #running = false

  #el<T extends HTMLElement>(selector: string): T {
    return this.querySelector<T>(selector)!
  }

  connectedCallback() {
    this.#el('.controls').hidden = false
    this.#el('.status').hidden = false
    this.#el('.static').hidden = true
    this.#el<HTMLTextAreaElement>('.editor').addEventListener('input', (e) => {
      if (this.#selected !== undefined) {
        this.#files[this.#selected] = (e.target as HTMLTextAreaElement).value
      }
    })
    this.#el<HTMLSelectElement>('.file').addEventListener('change', (e) => {
      this.#selected = (e.target as HTMLSelectElement).value
      this.#showFiles()
    })
    this.addEventListener('click', (e) => {
      const action = (e.target as Element).closest<HTMLButtonElement>('button[data-action]')
        ?.dataset['action']
      if (action === 'run') void this.#run()
      else if (action === 'reset') this.#reset()
      else if (action === 'add') this.#add()
      else if (action === 'delete') this.#delete()
    })
    this.#showFiles()
  }

  #say(text: string) {
    this.#el('.status').textContent = text
  }

  #showFiles() {
    const select = this.#el<HTMLSelectElement>('.file')
    select.replaceChildren(
      ...Object.keys(this.#files).map((f) => new Option(f, f, false, f === this.#selected)),
    )
    const editor = this.#el<HTMLTextAreaElement>('.editor')
    editor.value = this.#selected === undefined ? '' : this.#files[this.#selected]!
    editor.disabled = this.#selected === undefined
    this.#el<HTMLButtonElement>('button[data-action="delete"]').disabled =
      this.#selected === undefined
  }

  #add() {
    const input = this.#el<HTMLInputElement>('.new-path')
    const path = input.value.trim().replace(/^(\.?\/)+/, '')
    if (path === '') return this.#say('Name the new file first, for example packages/ui/README.md.')
    if (path in this.#files) return this.#say(`${path} already exists.`)
    this.#files[path] = ''
    this.#selected = path
    input.value = ''
    this.#showFiles()
    this.#el('.editor').focus()
    this.#say(`Added ${path}, empty. Run to see what it moves.`)
  }

  #delete() {
    const path = this.#selected
    if (path === undefined) return
    delete this.#files[path]
    this.#selected = firstFile(this.#files)
    this.#showFiles()
    this.#say(`Deleted ${path}. Run to see what it moves.`)
  }

  #reset() {
    this.#files = { ...FILES }
    this.#selected = firstFile(FILES)
    this.#cached = new Set()
    this.#last = undefined
    this.#el<HTMLTextAreaElement>('.env').value = envText(ENV)
    this.#el<HTMLInputElement>('.tasks').value = TASKS.join(' ')
    this.#el('.results').hidden = true
    this.#el('.order').hidden = true
    this.#el('.errors').hidden = true
    this.#showFiles()
    this.#say('Reset: the workspace as it opened, and an empty cache.')
  }

  async #run() {
    if (this.#running) return
    this.#running = true
    const button = this.#el<HTMLButtonElement>('button[data-action="run"]')
    button.disabled = true
    this.#say('Planning…')
    try {
      const env = parseEnv(this.#el<HTMLTextAreaElement>('.env').value)
      const tasks = parseTasks(this.#el<HTMLInputElement>('.tasks').value)
      if (!env.ok || !tasks.ok) {
        return this.#fail([...(env.ok ? [] : [env.error]), ...(tasks.ok ? [] : [tasks.error])])
      }
      let planner: Planner
      try {
        planner = await (this.#planner ??= this.#loadPlanner())
      } catch (e) {
        this.#planner = undefined
        return this.#fail([
          `the planner did not load: ${e instanceof Error ? e.message : String(e)}`,
        ])
      }
      const outcome = await runPlayground(planner, {
        files: this.#files,
        env: env.env,
        tasks: tasks.tasks,
        cached: this.#cached,
      })
      if (!outcome.ok) return this.#fail(outcome.errors)
      const rows = diffRuns(this.#last, outcome.tasks, planner.diffKeyComponents)
      this.#last = outcome.tasks
      this.#cached = outcome.cached
      const table = this.#el<HTMLTableElement>('.results')
      table.querySelector('tbody')!.replaceChildren(
        ...rows.map((r) => {
          const tr = document.createElement('tr')
          tr.dataset['change'] = r.change
          const th = document.createElement('th')
          th.scope = 'row'
          th.textContent = r.id
          tr.append(th)
          for (const text of [r.key, r.status, changeCell(r)]) {
            const td = document.createElement('td')
            td.textContent = text
            tr.append(td)
          }
          return tr
        }),
      )
      table.querySelector('caption')!.textContent =
        `vx run ${tasks.tasks.join(' ')} --all: each task's key, and what the simulated cache says.`
      table.dataset['stale'] = 'false'
      table.hidden = false
      const order = this.#el('.order')
      order.textContent = orderLine(outcome.dispatchOrder)
      order.hidden = false
      this.#el('.errors').hidden = true
      this.#say(summarize(rows))
    } finally {
      this.#running = false
      button.disabled = false
    }
  }

  #loadPlanner(): Promise<Planner> {
    const url = this.#el('.controls').dataset['planner']!
    return import(/* @vite-ignore */ url) as Promise<Planner>
  }

  #fail(errors: string[]) {
    const list = this.#el('.errors')
    list.replaceChildren(
      ...errors.map((e) => {
        const li = document.createElement('li')
        li.textContent = e
        return li
      }),
    )
    list.hidden = false
    const table = this.#el<HTMLTableElement>('.results')
    const kept = !table.hidden
    if (kept) {
      table.dataset['stale'] = 'true'
      table.querySelector('caption')!.textContent =
        'Stale: the last good run. The run after it failed, with the errors above.'
    }
    this.#say(failureSummary(errors, kept))
  }
}

customElements.define('vx-playground', Playground)
