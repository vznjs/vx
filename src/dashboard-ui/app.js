// Tiny hash router. Each page module exports `render(container)` and is
// looked up by path. No build step, no framework.

import { renderOverview } from '/pages/overview.js'
import { renderCache } from '/pages/cache.js'

const routes = {
  '/overview': renderOverview,
  '/cache': renderCache,
}

const container = document.getElementById('page')

function currentPath() {
  const hash = location.hash || '#/overview'
  return hash.startsWith('#') ? hash.slice(1) : hash
}

function render() {
  const path = currentPath()
  setActiveNav(path)
  const handler = routes[path]
  if (!handler) {
    // Other pages will land here until their PRs ship.
    container.innerHTML = '<div class="empty">page not implemented yet — coming in a later PR</div>'
    return
  }
  container.innerHTML = '<div class="empty">loading…</div>'
  Promise.resolve()
    .then(() => handler(container))
    .catch((err) => {
      container.innerHTML = `<div class="error">${escape(String(err))}</div>`
    })
}

function setActiveNav(path) {
  for (const a of document.querySelectorAll('.nav a')) {
    a.classList.toggle('active', a.getAttribute('data-route') === path)
  }
}

function escape(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

if (!location.hash) location.replace('#/overview')
window.addEventListener('hashchange', render)
render()
