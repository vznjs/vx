// The site's one copy of the benchmark data: src/data/bench.json, the
// committed copy of what `bench.data` gathers from the bench tasks' rows.
// A static import: a build without it fails to resolve it, so no page
// ships without its figures. Main's deploy names the newest numbers Bench
// measured in VX_DOCS_BENCH (deploy.pages, scripts/live-bench.ts): read
// here, not by a Vite alias, because astro.config.mjs loads this module
// outside Vite for the markdown plugin (src/plugins/bench.ts), and the
// alias left every markdown page on the committed copy.
import { readFileSync } from 'node:fs'
import committed from '../data/bench.json'
import { figures, fill, type BenchData } from './format.ts'

const live = process.env['VX_DOCS_BENCH']
const raw: unknown = live ? JSON.parse(readFileSync(live, 'utf8')) : committed

export const BENCH = raw as BenchData
export const FIGURES = figures(BENCH)
export const fillBench = (text: string): string => fill(text, FIGURES)
