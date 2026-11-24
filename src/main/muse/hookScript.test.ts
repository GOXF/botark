import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { MUSE_HOOK_SCRIPT } from './hookScript'

it('reuses the document discovery timer across hook reinjections', () => {
  const window = { sendRequest: undefined as (() => void) | undefined }
  const timers = new Map<number, () => void>()
  const setInterval = vi.fn((callback: () => void) => {
    const id = timers.size + 1
    timers.set(id, callback)
    return id
  })
  const clearInterval = (id: number) => timers.delete(id)
  const context = { window, document: { querySelector: () => null }, setInterval, clearInterval }
  expect(runInNewContext(MUSE_HOOK_SCRIPT, context).hook).toBe('dom')
  expect(runInNewContext(MUSE_HOOK_SCRIPT, context).hook).toBe('dom')
  expect(setInterval).toHaveBeenCalledOnce()
  window.sendRequest = () => undefined
  timers.get(1)?.()
  expect(runInNewContext(MUSE_HOOK_SCRIPT, context).hook).toBe('sendRequest')
  expect(timers.size).toBe(0)
  expect(setInterval).toHaveBeenCalledOnce()
})
