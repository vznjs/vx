// The numbers this deploy shows, as data: CI's Bench job reads the live
// copy and publishes a new run only when vx is no worse against Turbo
// (scripts/bench-gate.ts).
import type { APIRoute } from 'astro'
import { BENCH } from '../bench/data.ts'

export const GET: APIRoute = () => new Response(JSON.stringify(BENCH))
