// The suite tests `github()` as an Actions runner sees it; the off-Actions
// side sets the variable back itself (`off-actions.test.ts`).
process.env['GITHUB_ACTIONS'] = 'true'
