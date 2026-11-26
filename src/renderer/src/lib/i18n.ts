import { useCallback } from 'react'
import { usePrefsStore, type Locale } from '@/store/prefsStore'
import { ZH } from './i18n.zh'

/** Lightweight i18n: English source strings are keys; zh-CN dictionary overrides. `{name}` placeholders. */
export function translate(locale: Locale, text: string, vars?: Record<string, string | number>): string {
  const out = locale === 'zh' ? (ZH[text] ?? text) : text
  return vars
    ? out.replace(/\{([^{}]+)\}/g, (placeholder, key: string) =>
        Object.hasOwn(vars, key) ? String(vars[key]) : placeholder
      )
    : out
}

export type TFn = (text: string, vars?: Record<string, string | number>) => string

export function plural(t: TFn, n: number, singular: string, plural: string): string {
  return t(n === 1 ? singular : plural, { n })
}

export function useT(): TFn {
  const locale = usePrefsStore((s) => s.locale)
  return useCallback<TFn>((text, vars) => translate(locale, text, vars), [locale])
}

/** Non-hook access (stores, helpers). */
export const t: TFn = (text, vars) => translate(usePrefsStore.getState().locale, text, vars)
