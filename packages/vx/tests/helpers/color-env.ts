// The gate's test tasks set FORCE_COLOR=0 (vx.config.ts), so the suite reads
// vx's output as plain text. A bare `bun test` gets the same here: without
// it, a test that sets CI=1 for its child (CI turns colour on, ui/theme.ts)
// read painted stderr. A host's NO_COLOR goes too, so a test that turns
// colour on with FORCE_COLOR sees what CI sees.
process.env['FORCE_COLOR'] = '0'
delete process.env['NO_COLOR']
