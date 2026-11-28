import { afterEach, expect, it, vi } from 'vitest'
import { useBotStore } from '@/store/botStore'
import { usePromptStore } from '@/store/promptStore'
import { openSettingsFromMenu } from './shortcuts'

const { hasOpenOverlay } = vi.hoisted(() => ({ hasOpenOverlay: vi.fn(() => false) }))
vi.mock('./overlay', () => ({ hasOpenOverlay }))

afterEach(() => {
  useBotStore.setState({ addBotOpen: false, paletteOpen: false, onboardingOpen: false, settingsOpen: false })
  usePromptStore.setState({ libraryOpen: false })
  hasOpenOverlay.mockReturnValue(false)
})

it.each(['addBotOpen', 'paletteOpen'] as const)('respects %s before the dialog mounts', (key) => {
  useBotStore.setState({ [key]: true })
  openSettingsFromMenu()
  expect(useBotStore.getState()).toMatchObject({ [key]: true, settingsOpen: false })
})
it('does not dismiss a prompt editor or navigate underneath another overlay', () => {
  usePromptStore.setState({ libraryOpen: true })
  openSettingsFromMenu()
  expect(useBotStore.getState().settingsOpen).toBe(false)
  expect(usePromptStore.getState().libraryOpen).toBe(true)
  usePromptStore.setState({ libraryOpen: false })
  hasOpenOverlay.mockReturnValue(true)
  openSettingsFromMenu()
  expect(useBotStore.getState().settingsOpen).toBe(false)
})
it('opens Settings from the workspace or the onboarding guide', () => {
  openSettingsFromMenu()
  expect(useBotStore.getState().settingsOpen).toBe(true)
  useBotStore.setState({ settingsOpen: false, onboardingOpen: true })
  hasOpenOverlay.mockReturnValue(true)
  openSettingsFromMenu()
  expect(useBotStore.getState()).toMatchObject({ onboardingOpen: false, settingsOpen: true })
})
