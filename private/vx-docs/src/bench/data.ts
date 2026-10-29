// The site's one copy of the benchmark data. A static import: a build with
// no src/data/bench.json (written by `bench.data` from the bench tasks'
// rows) fails to resolve it, so no page ships without its figures.
import raw from '../data/bench.json'
import { figures, fill, type BenchData } from './format.ts'

export const BENCH = raw as unknown as BenchData
export const FIGURES = figures(BENCH)
export const fillBench = (text: string): string => fill(text, FIGURES)
