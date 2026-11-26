const ONBOARDING_SEEN_KEY = 'bothub.onboarding.seen.v2'

export function hasSeenOnboarding(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(ONBOARDING_SEEN_KEY) === '1'
  } catch {
    return false
  }
}

export function markOnboardingSeen(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(ONBOARDING_SEEN_KEY, '1')
  } catch {
    /* ignore */
  }
}
