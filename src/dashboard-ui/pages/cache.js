import { escapeHtml, fetchJson, fmtAge, fmtBytes, fmtDuration, shortHash } from '/format.js'

export async function renderCache(container) {
  const entries = await fetchJson('/api/cache/entries?limit=500')

  if (entries.length === 0) {
    container.innerHTML = `
      <h1>Cache</h1>
      <div class="empty">no cache entries yet — run a task with <code>cache:</code> declared</div>
    `
    return
  }

  const totalBytes = entries.reduce((s, e) => s + (e.sizeBytes ?? 0), 0)

  container.innerHTML = `
    <h1>Cache</h1>
    <div class="cards">
      <div class="card">
        <div class="label">Entries (showing)</div>
        <div class="value">${entries.length.toLocaleString()}</div>
      </div>
      <div class="card">
        <div class="label">Size (showing)</div>
        <div class="value">${escapeHtml(fmtBytes(totalBytes))}</div>
      </div>
    </div>

    <table class="data">
      <thead>
        <tr>
          <th>Hash</th>
          <th>Project</th>
          <th>Task</th>
          <th class="num">Size</th>
          <th class="num">Duration</th>
          <th>Last access</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        ${entries.map(renderRow).join('')}
      </tbody>
    </table>
  `
}

function renderRow(e) {
  return `
    <tr>
      <td><span class="hash">${escapeHtml(shortHash(e.hash))}</span></td>
      <td><code>${escapeHtml(e.project)}</code></td>
      <td><code>${escapeHtml(e.task)}</code></td>
      <td class="num">${escapeHtml(fmtBytes(e.sizeBytes))}</td>
      <td class="num">${escapeHtml(fmtDuration(e.durationMs))}</td>
      <td>${escapeHtml(fmtAge(e.accessedAt))}</td>
      <td>${escapeHtml(fmtAge(e.createdAt))}</td>
    </tr>`
}
