// A `with { type: 'file' }` import of a file SRT vendors: Bun hands back its path.
declare module '@anthropic-ai/sandbox-runtime/vendor/seccomp/*' {
  const path: string
  export default path
}

// The same of vx's own observer (`observe/`, built by scripts/build-observe.ts).
declare module '*/observe/vx-observe-x64' {
  const path: string
  export default path
}
declare module '*/observe/vx-observe-arm64' {
  const path: string
  export default path
}
