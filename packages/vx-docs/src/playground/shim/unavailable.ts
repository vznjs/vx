// An export a bundled module names but the plan should never call: it exists
// so the bundle links, and a call is a claim the plan path is wrong about.
// The module joins the name at call time so the bundle holds no
// "<specifier> <name>" string, which the build test reads as a stub the
// plan kept.
export function notInPlayground(name: string, module?: string): () => never {
  const what = module === undefined ? name : `${module} ${name}`
  return () => {
    throw new Error(`playground: ${what} is not available (the plan should not reach it)`)
  }
}
