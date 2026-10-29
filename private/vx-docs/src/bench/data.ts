// The site's one copy of the benchmark data: src/data/bench.json, the
// committed copy of what `bench.data` gathers from the bench tasks' rows.
// A static import: a build without it fails to resolve it, so no page
// ships without its figures.
import raw from '../data/bench.json'
import { figures, fill, type BenchData } from './format.ts'

export const BENCH = raw as unknown as BenchData
export const FIGURES = figures(BENCH)
export const fillBench = (text: string): string => fill(text, FIGURES)
