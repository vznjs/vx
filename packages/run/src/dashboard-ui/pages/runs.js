import { escapeHtml, fetchJson, fmtAge, fmtDuration, shortRunId } from '/format.js'

export async function renderRuns(container) {
  const rows = await fetchJson('/api/runs?limit=200')

  if (rows.length === 0) {
    container.innerHTML = `
      <h1>Runs</h1>
      <div class="empty">no runs recorded yet — invoke <code>vzn run &lt;task&gt;</code></div>
    `
    return
  }

  container.innerHTML = `
    <h1>Runs</h1>
    <p class="dim">
      Every <code>vzn run</code> invocation. Click a row to inspect each
      task's wall-clock span on the flamegraph.
    </p>
    <table class="data">
      <thead>
        <tr>
          <th>Run</th>
          <th>Started</th>
          <th class="num">Duration</th>
          <th class="num">Tasks</th>
          <th class="num">OK</th>
          <th class="num">Cached</th>
          <th class="num">Failed</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(renderRow).join('')}
      </tbody>
    </table>
  `
}

function renderRow(r) {
  const startedIso = new Date(r.startedAt).toLocaleString()
  return `
    <tr>
      <td>
        <a href="#/runs/${encodeURIComponent(r.runId)}" class="hash">
          ${escapeHtml(shortRunId(r.runId))}
        </a>
      </td>
      <td title="${escapeHtml(startedIso)}">${escapeHtml(fmtAge(r.startedAt))}</td>
      <td class="num">${escapeHtml(fmtDuration(r.durationMs))}</td>
      <td class="num">${r.taskCount}</td>
      <td class="num">${r.successCount}</td>
      <td class="num">${r.cacheHitCount}</td>
      <td class="num">${
        r.failedCount > 0 ? `<span class="status failed">${r.failedCount}</span>` : '0'
      }</td>
    </tr>`
}
