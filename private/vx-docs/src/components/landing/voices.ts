// What people said about vx, word for word: the quote, who said it and
// their role, nothing else. Public posts only; each links to its source.

export interface Voice {
  quote: string
  who: string
  role: string
  href: string
}

const PR = 'https://github.com/vznjs/vx/pull/3286'
const shew = (quote: string, comment?: string): Voice => ({
  quote,
  who: 'Anthony Shew',
  role: 'Full-stack comedian, Turborepo at Vercel',
  href: comment ? `${PR}#issuecomment-${comment}` : PR,
})
const devto = (who: string, user: string, comment: string, quote: string): Voice => ({
  quote,
  who,
  role: 'dev.to',
  href: `https://dev.to/${user}/comment/${comment}`,
})

const misleading = shew('The benchmarks presented by this project are misleading.')
const reproducible = shew(
  'Just because a benchmark is reproducible doesn’t make it useful.',
  '6085989849',
)
const bugs = shew(
  'The remaining 1.36x difference is almost entirely made up of correctness bugs in vx',
  '6085989849',
)
const doesntWork = shew(
  'There’s a specific reason that none of the build systems that you’re comparing against don’t do what you’re doing: It doesn’t work.',
  '6085989849',
)
const distributed = shew('Distributed compute exists.', '6082220886')
const infinitely = shew(
  'Are you going to also publicize that your default algorithm can also be infinitely slower?',
  '6082220886',
)
const honest = devto(
  'Arjun Sharma',
  'sgaggjhkjh',
  '3hogn',
  'The root package.json invalidation row is the most honest data point here.',
)
const misses = devto(
  'Launch Gate',
  'launchgatecheck',
  '3kecc',
  'Keeping vx’s own two misses in the table is what makes the rest of the table readable.',
)
const contract = devto(
  'Sina Rezaei',
  'sinarezaei',
  '3h1ie',
  'The explicit-input approach makes sense, but it puts a lot of weight on getting the dependency contract right.',
)
const npm: Voice = {
  quote: 'Plugin packages (@vzn/vx-reapi, @vzn/vx-migrate, …) are not published to npm',
  who: 'qdesrame',
  role: 'GitHub',
  href: 'https://github.com/vznjs/vx/issues/1891',
}

// One small card beside the part of the page each quote is about.
export const BAND_VOICES = {
  proof: [bugs, misses, contract],
  speed: [misleading, reproducible, honest],
  dte: [doesntWork, distributed, infinitely],
  plugins: [npm],
}

// Everything, for the big section.
export const ALL_VOICES: Voice[] = [
  misleading,
  honest,
  shew('Your agent is extremely wrong at the conclusions its making.', '6080917922'),
  misses,
  doesntWork,
  devto(
    'Launch Gate',
    'launchgatecheck',
    '3kecc',
    'The cannot-express-counts-as-fail rule is the right default',
  ),
  shew('a young project made by someone without build systems knowledge', '6085989849'),
  contract,
  distributed,
  npm,
  shew('The benchmark you’re using is overfit to your specific algorithm.', '6085989849'),
  bugs,
  infinitely,
  devto(
    'Launch Gate',
    'launchgatecheck',
    '3kecc',
    '984/984 measures the union’s coverage, not correctness.',
  ),
  reproducible,
  shew('Build systems pushing each other is good for everyone.', '6085989849'),
]
