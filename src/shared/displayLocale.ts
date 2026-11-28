/** Only the primary renderer may send this display preference to the main process. */
export const DISPLAY_LOCALE_CHANNEL = 'display-locale:changed'

export type DisplayLocale = 'en' | 'zh'

export function isDisplayLocale(value: unknown): value is DisplayLocale {
  return value === 'en' || value === 'zh'
}
