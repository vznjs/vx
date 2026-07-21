// React root: astryx theme + hash router. The SPA builds to ONE self-contained
// index.html (vite singleFile plugin) embedded into the vx-cloud binary, so
// hash routing keeps deep links working with no server-side route table.

import '@astryxdesign/core/reset.css'
import '@astryxdesign/core/astryx.css'
import './fonts.css'
import './brand.css'
import { StrictMode, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { Theme } from '@astryxdesign/core/theme'
import { vxTheme } from './theme.ts'
import { App } from './App.tsx'
import { getStoredMode, useThemeMode } from './theme-mode.ts'

function Root(): JSX.Element {
  const [mode] = useThemeMode()
  return (
    <Theme theme={vxTheme} mode={mode}>
      <HashRouter>
        <App />
      </HashRouter>
    </Theme>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')
document.documentElement.style.colorScheme = getStoredMode() === 'light' ? 'light' : 'dark'
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
