// `<vx-graph-explorer>`: enhances `GraphExplorer.astro`. The reader pastes
// or opens a `vx run … --dry=json` plan; the element names one task's
// predicted status, what it waits on and what waits on it, and, given a
// second task, the chain of edges between them. Nothing is sent anywhere.
import {
  parsePlan,
  search,
  statusWords,
  upstream,
  whyDepends,
  type Graph,
} from './model/graph-explorer.js'

class GraphExplorer extends HTMLElement {
  #graph: Graph | null = null

  connectedCallback() {
    this.querySelector<HTMLElement>('.controls')!.hidden = false
    this.querySelector<HTMLElement>('.js-hint')!.hidden = true
    this.addEventListener('click', (e) => {
      if ((e.target as Element).closest('.read') !== null) this.#read(this.#plan().value)
      const link = (e.target as Element).closest<HTMLElement>('[data-task]')
      if (link !== null) {
        this.#find().value = link.dataset['task']!
        this.#show()
      }
    })
    this.addEventListener('input', (e) => {
      if ((e.target as Element).matches('.find, .why-to')) this.#show()
    })
    this.querySelector<HTMLInputElement>('.file')!.addEventListener('change', (e) => {
      void this.#open((e.target as HTMLInputElement).files?.[0])
    })
    this.#plan().addEventListener('dragover', (e) => e.preventDefault())
    this.#plan().addEventListener('drop', (e) => {
      e.preventDefault()
      void this.#open(e.dataTransfer?.files[0])
    })
  }

  async #open(file: File | undefined) {
    if (file === undefined) return
    const text = await file.text()
    this.#plan().value = text
    this.#read(text)
  }

  #plan = () => this.querySelector<HTMLTextAreaElement>('.plan')!
  #find = () => this.querySelector<HTMLInputElement>('.find')!

  #say(text: string) {
    const status = this.querySelector<HTMLElement>('.status')!
    status.hidden = false
    status.textContent = text
  }

  #read(text: string) {
    const parsed = parsePlan(text)
    if ('error' in parsed) {
      this.#graph = null
      this.querySelector<HTMLElement>('.out')!.hidden = true
      return this.#say(parsed.error)
    }
    this.#graph = parsed
    const ids = this.querySelector('datalist')!
    ids.replaceChildren(
      ...search(parsed, '').map((id) =>
        Object.assign(document.createElement('option'), { value: id }),
      ),
    )
    this.#say(`Read ${parsed.tasks.size} tasks. Type one to see what it waits on.`)
    this.#show()
  }

  #show() {
    const graph = this.#graph
    const out = this.querySelector<HTMLElement>('.out')!
    if (graph === null) return
    const query = this.#find().value.trim()
    const id = graph.tasks.has(query) ? query : search(graph, query)[0]
    if (query === '' || id === undefined) {
      out.hidden = true
      if (query !== '') this.#say(`No task matches “${query}”.`)
      return
    }
    const t = graph.tasks.get(id)!
    const list = (ids: readonly string[]) =>
      ids.length === 0
        ? '<li class="is-muted">nothing</li>'
        : ids
            .map((d) => `<li><button type="button" data-task="${esc(d)}">${esc(d)}</button></li>`)
            .join('')
    const to = this.querySelector<HTMLInputElement>('.why-to')!.value.trim()
    const toId = to === '' ? undefined : graph.tasks.has(to) ? to : search(graph, to)[0]
    const chain = toId === undefined ? null : whyDepends(graph, id, toId)
    const why =
      toId === undefined
        ? ''
        : chain === null
          ? `<p>${esc(id)} never waits on ${esc(toId)}.</p>`
          : `<p>${esc(id)} waits on ${esc(toId)} through: <code>${chain.map(esc).join(' → ')}</code></p>`
    const onPath = graph.criticalPath.includes(id) ? ' It is on the predicted critical path.' : ''
    out.hidden = false
    out.innerHTML =
      `<p><strong>${esc(id)}</strong>: ${esc(statusWords(t.cacheStatus))}.${onPath} ` +
      `It waits on ${upstream(graph, id).size} tasks in all.</p>` +
      why +
      `<p>Waits on</p><ul>${list(t.deps)}</ul>` +
      `<p>Waited on by</p><ul>${list(graph.dependents.get(id) ?? [])}</ul>`
  }
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

customElements.define('vx-graph-explorer', GraphExplorer)
