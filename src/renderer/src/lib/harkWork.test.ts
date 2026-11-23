import { expect, it } from 'vitest'
import { accountWork, evaluate, markRun, setPolled, workingFromStatuses, type HarkWorkState } from './harkWork'

const empty: HarkWorkState = { projects: {}, seenAt: {} }
const hidden = () => false
const w = (s: HarkWorkState, conv = 'p1') => s.projects['a']![conv]!

it('works while run signals keep coming, then marks done when nobody watched', () => {
  let s = evaluate(markRun(empty, 'a', 'p1', 0), 0, hidden, [])
  expect(w(s).working).toBe(true)
  s = evaluate(markRun(s, 'a', 'p1', 20_000), 30_000, hidden, [])
  expect(w(s).working).toBe(true)
  s = evaluate(s, 46_000, hidden, [])
  expect(w(s)).toMatchObject({ working: false, doneAt: 46_000 })
  expect(accountWork(s, ['a'])).toEqual({ working: 0, doneAt: 46_000 })
})

it('a short flash or a run finished on screen is not "done"', () => {
  let s = evaluate(markRun(empty, 'a', 'p1', 0), 0, hidden, [])
  s = evaluate(setPolled(s, 'a', []), 26_000, hidden, [])
  expect(w(s).doneAt).toBe(26_000)
  let flash = evaluate(setPolled(empty, 'a', ['p1']), 0, hidden, [])
  flash = evaluate(setPolled(flash, 'a', []), 5_000, hidden, [])
  expect(w(flash)).toMatchObject({ working: false, doneAt: 0 })
  let seen = evaluate(markRun(empty, 'a', 'p1', 0), 0, () => true, [])
  seen = evaluate(seen, 30_000, () => true, [])
  expect(w(seen).doneAt).toBe(0)
})

it('opening the project clears its marker; viewing the bot clears only the sidebar', () => {
  let s = evaluate(markRun(empty, 'a', 'p1', 0), 0, hidden, [])
  s = evaluate(s, 30_000, hidden, [])
  s = evaluate(s, 31_000, hidden, ['a'])
  expect(w(s).doneAt).toBe(30_000)
  expect(accountWork(s, ['a']).doneAt).toBe(0)
  s = evaluate(s, 32_000, (_acc, conv) => conv === 'p1', [])
  expect(w(s).doneAt).toBe(0)
})

it('counts working projects from Hark status for the sidebar', () => {
  const s = evaluate(setPolled(empty, 'a', ['p1', 'p2']), 0, hidden, [])
  expect(accountWork(s, ['a'])).toEqual({ working: 2, doneAt: 0 })
})

it('reads working ids from either status shape', () => {
  expect(workingFromStatuses({ statuses: { c1: 'working', c2: 'unread', c3: 'idle' } })).toEqual(['c1'])
  expect(workingFromStatuses({ statuses: [{ conversationId: 'c1', status: 'running' }, { id: 'c2', working: false }] })).toEqual(['c1'])
  expect(workingFromStatuses({})).toBeNull()
})
