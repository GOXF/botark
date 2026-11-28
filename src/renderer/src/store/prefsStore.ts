import type { DisplayLocale } from '@shared/displayLocale'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemePref = 'system' | 'light' | 'dark'
export type Locale = DisplayLocale

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

/** Match the first supported system language; keep English as the fallback. */
export function resolveInitialLocale(preferredLanguages: readonly string[]): Locale {
  for (const tag of preferredLanguages) {
    const language = tag.split(/[-_]/)[0]?.toLowerCase()
    if (language === 'en' || language === 'zh') return language
  }
  return 'en'
}

/** Persist an explicit language selection without changing existing preferences. */
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

/** Report the hydrated preference and real language changes, not theme changes. */
export function createLocaleSync(send: (locale: Locale) => void): (locale: Locale) => void {
  let last: Locale | undefined
  return (locale) => {
    if (locale === last) return
    last = locale
    send(locale)
  }
}

/** Keep HTML and the native application UI in sync with the same language. */
export function startPrefsSync(): () => void {
  const root = document.documentElement
  const syncLocale = createLocaleSync((locale) => window.electron?.setDisplayLocale?.(locale))
  const apply = () => {
    const { theme, locale } = usePrefsStore.getState()
    root.dataset.theme = resolve(theme)
    root.lang = locale === 'zh' ? 'zh-CN' : 'en'
    syncLocale(locale)
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
