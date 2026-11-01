// The numbers this build prints, served beside the pages: the Bench job
// reads the live copy to hold the next run to it (scripts/bench-pick.ts).
import type { APIRoute } from 'astro'
import { BENCH } from '../bench/data.ts'

export const GET: APIRoute = () =>
  new Response(JSON.stringify(BENCH, null, 2) + '\n', {
    headers: { 'content-type': 'application/json' },
  })
