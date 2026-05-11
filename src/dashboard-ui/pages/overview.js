import { escapeHtml, fetchJson, fmtBytes, fmtDuration, fmtPercent, shortRunId } from '/format.js'

export async function renderOverview(container) {
  const data = await fetchJson('/api/overview')
  const { cache, recentRuns } = data

  const cards = [
    {
      label: 'Cache entries',
      value: cache.entryCount.toLocaleString(),
      sub: fmtBytes(cache.totalBytes),
    },
    {
      label: 'Runs (24h)',
      value: cache.runCountLast24h.toLocaleString(),
    },
    {
      label: 'Cache hits (24h)',
      value: cache.hitCountLast24h.toLocaleString(),
    },
    {
      label: 'Hit rate (24h)',
      value: fmtPercent(cache.hitRateLast24h),
    },
  ]

  const cardsHtml = cards
    .map(
      (c) => `
        <div class="card">
          <div class="label">${escapeHtml(c.label)}</div>
          <div class="value">${escapeHtml(c.value)}</div>
          ${c.sub ? `<div class="sub">${escapeHtml(c.sub)}</div>` : ''}
        </div>`,
    )
    .join('')

  const runsHtml = recentRuns.length
    ? `
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
          ${recentRuns.map(renderRunRow).join('')}
        </tbody>
      </table>`
    : '<div class="empty">no runs recorded yet — run <code>vzn run &lt;task&gt;</code></div>'

  container.innerHTML = `
    <h1>Overview</h1>
    <div class="cards">${cardsHtml}</div>
    <h2>Recent runs</h2>
    ${runsHtml}
  `
}

function renderRunRow(r) {
  const startedIso = new Date(r.startedAt).toLocaleString()
  return `
    <tr>
      <td><span class="hash">${escapeHtml(shortRunId(r.runId))}</span></td>
      <td>${escapeHtml(startedIso)}</td>
      <td class="num">${escapeHtml(fmtDuration(r.durationMs))}</td>
      <td class="num">${r.taskCount}</td>
      <td class="num">${r.successCount}</td>
      <td class="num">${r.cacheHitCount}</td>
      <td class="num">${
        r.failedCount > 0 ? `<span class="status failed">${r.failedCount}</span>` : '0'
      }</td>
    </tr>`
}
