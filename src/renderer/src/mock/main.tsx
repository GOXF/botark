/**
 * GOXF design mockups: render real app components for screenshots.
 *
 * Entry: src/renderer/mock.html, built only by vite.mock.config.mts and
 * driven by scripts/goxf-mock.mjs. Nothing in the app imports this folder,
 * so it never ships. URL: mock.html?mock=<name>&theme=light|dark
 */
import '@fontsource-variable/inter'
import '../styles/globals.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { usePrefsStore } from '@/store/prefsStore'
import { MOCKS } from './registry'

const params = new URLSearchParams(window.location.search)
const name = params.get('mock') ?? ''
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'

// Mocks are always Chinese and use the theme from the URL, not saved prefs.
usePrefsStore.setState({ theme, locale: 'zh' })
document.documentElement.dataset.theme = theme
document.documentElement.lang = 'zh-CN'
// The app locks body scrolling; a mock page grows with its content.
document.body.style.overflow = 'visible'

const Mock = MOCKS[name]
const root = document.getElementById('root')
if (!root) throw new Error('#root missing')

createRoot(root).render(
  <StrictMode>
    {Mock ? (
      <div id="mock-frame" className="inline-block bg-canvas p-8">
        <Mock />
      </div>
    ) : (
      <div className="p-8 text-[14px] text-ink">
        未知 mock「{name}」。可用：{Object.keys(MOCKS).join('、') || '（无）'}
      </div>
    )}
  </StrictMode>
)
