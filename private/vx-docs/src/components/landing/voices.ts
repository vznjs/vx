// What people said about vx, word for word: the quote, who said it and
// their role, nothing else. Real, public words about vx only; each links
// to where it was said.

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

const A = '6080917922'
const B = '6082220886'
const C = '6085989849'

const agent = shew(
  'Can you read this yourself? Your agent is extremely wrong at the conclusions its making.',
  A,
)
const absolute = shew(
  'these statements are being provided as absolute truth when they’re absolutely not',
  A,
)
const provably = shew(
  'why would you stand by statements that are literally and provably incorrect?',
  B,
)
const infinitely = shew(
  'Are you going to also publicize that your default algorithm can also be infinitely slower?',
  B,
)
const post = shew('This doesn’t mean you should post misleading information.', B)
const distributed = shew('Distributed compute exists.', B)
const misleading = shew('The benchmarks presented by this project are misleading.')
const dishonest = shew(
  'To say that vx is faster than other build tools because of this is dishonest.',
)
const meaningless = shew('unblocking more tasks sooner is generally meaningless at scale')
const itJustIs = shew('it absolutely is still misleading. Its not a disagreement; it just is.', C)
const reproducible = shew('Just because a benchmark is reproducible doesn’t make it useful.', C)
const overfit = shew('The benchmark you’re using is overfit to your specific algorithm.', C)
const configure = shew(
  'If your users can configure their way out of that, that’s fine, but then its dishonest to claim the numbers that you are.',
  C,
)
const doesntWork = shew(
  'There’s a specific reason that none of the build systems that you’re comparing against don’t do what you’re doing: It doesn’t work.',
  C,
)
const boon = shew(
  'Do you think that we all would be leaving such a performance boon on the table if it did work?',
  C,
)
const experience = shew(
  'those of us with experience in build systems know that this algorithm is incorrect',
  C,
)
const claude = shew('I obviously don’t know if you did that on purpose or Claude chose to do it', C)
const intent = shew('But now I’m disappointed because it seems your intent is to be dishonest.', C)
const bugs = shew(
  'The remaining 1.36x difference is almost entirely made up of correctness bugs in vx',
  C,
)
const young = shew('a young project made by someone without build systems knowledge', C)
const helped = shew(
  'I’m glad to have helped. Build systems pushing each other is good for everyone.',
  C,
)
const honest = shew(
  'I’d hope that we all can still seek to 1) learn and 2) be honest, especially with AI around.',
  C,
)

// A quiet line beside the title of the band each is about.
export const BAND_VOICES = {
  proof: [bugs, young],
  speed: [misleading, reproducible, overfit, itJustIs],
  dte: [doesntWork, distributed, infinitely],
  plugins: [experience, boon],
  agents: [agent, claude],
}

// Everything, for the big section.
export const ALL_VOICES: Voice[] = [
  misleading,
  agent,
  doesntWork,
  young,
  infinitely,
  itJustIs,
  distributed,
  claude,
  overfit,
  absolute,
  bugs,
  provably,
  boon,
  dishonest,
  experience,
  post,
  reproducible,
  intent,
  meaningless,
  configure,
  honest,
  helped,
]
