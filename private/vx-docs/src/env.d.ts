// astro's client types (import.meta.env, `astro:assets`) for the lint
// task's type-check, which runs before astro generates .astro/types.d.ts.
/// <reference types="astro/client" />

// A .ts file that re-exports components (the teaching kit's index.ts) is
// type-checked by tsgolint, which has no Astro plugin to read a .astro file.
declare module '*.astro' {
  const Component: (props: Record<string, unknown>) => unknown
  export default Component
}
