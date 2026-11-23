import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemePref = 'system' | 'light' | 'dark'
export type Locale = 'zh' | 'en'

interface PrefsState {
  theme: ThemePref
  locale: Locale
  /** Platforms whose (new) accounts get a pool proxy automatically. */
  proxyAssignPlatforms: string[]
  /** Accounts per pool proxy for auto-assignment; 0 = unlimited. Manual binding ignores it. */
  proxyPerProxyLimit: number
  setTheme: (theme: ThemePref) => void
  setLocale: (locale: Locale) => void
  setProxyAssignPlatforms: (platforms: string[]) => void
  setProxyPerProxyLimit: (limit: number) => void
}

/** UI preferences (local only). Light theme + Chinese by default. */
export const usePrefsStore = create<PrefsState>()(
  persist(
    (set) => ({
      theme: 'light',
      locale: 'zh',
      // The platforms new accounts were auto-assigned for before this was configurable.
      proxyAssignPlatforms: ['meta-muse', 'grok', 'dot', 'hark', 'antigravity', 'cue'],
      proxyPerProxyLimit: 0,
      setTheme: (theme) => set({ theme }),
      setLocale: (locale) => set({ locale }),
      setProxyAssignPlatforms: (proxyAssignPlatforms) => set({ proxyAssignPlatforms }),
      setProxyPerProxyLimit: (proxyPerProxyLimit) => set({ proxyPerProxyLimit })
    }),
    { name: 'bothub-prefs-v1' }
  )
)

function resolve(theme: ThemePref): 'light' | 'dark' {
  if (theme !== 'system') return theme
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Keep <html data-theme> and lang in sync with prefs and the OS setting. */
export function startPrefsSync(): () => void {
  const root = document.documentElement
  const apply = () => {
    const { theme, locale } = usePrefsStore.getState()
    root.dataset.theme = resolve(theme)
    root.lang = locale === 'zh' ? 'zh-CN' : 'en'
  }
  apply()
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
  mq?.addEventListener?.('change', apply)
  const unsub = usePrefsStore.subscribe(apply)
  return () => {
    mq?.removeEventListener?.('change', apply)
    unsub()
  }
}
