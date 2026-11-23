// Every case in one small file for the conformance page's search: ref,
// category, id, title, then one letter per tool in the page's column order
// (p pass, f fail, n N/A). The page fetches it the first time the search
// box is used, so the page itself stays small.
import { RANKED, RESULTS } from '../../conformance/data.ts'

export function GET(): Response {
  const rows = RESULTS.cases.map((c) => [
    c.ref,
    c.category,
    c.id,
    c.title,
    RANKED.map((t) => (c.outcomes[t]?.status ?? 'n/a')[0]).join(''),
  ])
  return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } })
}
