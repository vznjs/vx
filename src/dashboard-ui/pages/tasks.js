import { escapeHtml, fetchJson, fmtDuration } from '/format.js'

export async function renderTasks(container) {
  const rows = await fetchJson('/api/tasks/slowest?limit=200')

  if (rows.length === 0) {
    container.innerHTML = `
      <h1>Tasks</h1>
      <div class="empty">no successful task runs yet</div>
    `
    return
  }

  container.innerHTML = `
    <h1>Tasks</h1>
    <p class="dim">
      Ranked by average wall-clock duration. Cache hits are excluded so the
      ranking reflects work actually done, not cached.
    </p>
    <table class="data">
      <thead>
        <tr>
          <th>Project</th>
          <th>Task</th>
          <th class="num">Runs</th>
          <th class="num">Avg duration</th>
          <th class="num">Max duration</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(renderRow).join('')}
      </tbody>
    </table>
  `
}

function renderRow(t) {
  return `
    <tr>
      <td><code>${escapeHtml(t.project)}</code></td>
      <td><code>${escapeHtml(t.task)}</code></td>
      <td class="num">${t.runCount}</td>
      <td class="num">${escapeHtml(fmtDuration(t.avgDurationMs))}</td>
      <td class="num">${escapeHtml(fmtDuration(t.maxDurationMs))}</td>
    </tr>`
}
