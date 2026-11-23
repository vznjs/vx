# Docs pictures, one module per area

Each Docs area draws its pictures from its own module here
(`<area>.ts`, exporting `Picture` values), so two pages edited at once never
touch the same file. `tests/docs-pictures.test.ts` holds every module here to
the kit's laws: each label fits its box, and each picture has a phone layout
(`narrow`, at most 360 wide) with the same boxes and arrows. The kit itself:
`../../guide/diagram/README.md`.
