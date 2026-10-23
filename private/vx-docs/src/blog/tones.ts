// A drawn cover's hue from its post's first tag that names one, from the
// landing's palette; FALLBACK for every other post. Plain data: the cover
// backgrounds script (scripts/cover-backgrounds.ts) reads it outside Astro.
export const TONES: [string[], string][] = [
  [['caching', 'correctness', 'sandbox'], '#5ee0ff'],
  [['performance', 'benchmarks', 'internals'], '#ff9d42'],
  [['plugins', 'execution', 'remote-execution', 'agents', 'telemetry', 'ci'], '#6aa8ff'],
  [['dx', 'config', 'migration', 'turborepo', 'nx', 'comparison'], '#ff5e9c'],
]

export const FALLBACK = '#c6f84e'

export const TONE_COLORS = [...TONES.map(([, c]) => c), FALLBACK]
