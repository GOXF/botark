import { expect, it } from 'vitest'
import {
  HARK_PENDING_PROJECT_TTL_MS,
  HARK_PROJECTS_MIN_REFRESH_GAP_MS,
  harkCreateProjectBody,
  harkProjects,
  mergePendingHarkProjects,
  prunePendingHarkProjects,
  shouldRefreshHarkProjects
} from './harkProjects'

it('keeps the untitled main conversation distinct from archived projects', () => {
  expect(
    harkProjects({
      conversations: [
        { id: 'main', title: null, archivedAt: null },
        { id: 'project', title: 'Draft', archivedAt: 1 }
      ]
    })
  ).toEqual([
    { id: 'main', title: '主会话', main: true, archived: false },
    { id: 'project', title: 'Draft', main: false, archived: true }
  ])
})

it('sends autoTitle and timezone when creating a project', () => {
  expect(harkCreateProjectBody(' 抖店运维 ', 'Asia/Shanghai')).toEqual({
    title: '抖店运维',
    timezone: 'Asia/Shanghai',
    autoTitle: false
  })
  expect(harkCreateProjectBody('', 'Asia/Shanghai')).toEqual({
    title: '新项目',
    timezone: 'Asia/Shanghai',
    autoTitle: true
  })
})

it('keeps a just-created project visible until Hark lists it', () => {
  const rows = [
    { id: 'main', title: '主会话', main: true, archived: false },
    { id: 'old', title: 'Old', main: false, archived: false }
  ]
  const pending = [{ id: 'new', title: '新项目', createdAt: 1_000 }]
  expect(mergePendingHarkProjects(rows, pending, 2_000).map((r) => r.id)).toEqual(['main', 'new', 'old'])
  expect(prunePendingHarkProjects(rows, pending, 2_000)).toEqual(pending)
  const listed = [...rows, { id: 'new', title: '服务端标题', main: false, archived: false }]
  expect(mergePendingHarkProjects(listed, pending, 2_000)).toBe(listed)
  expect(prunePendingHarkProjects(listed, pending, 2_000)).toEqual([])
  expect(mergePendingHarkProjects(rows, pending, 1_000 + HARK_PENDING_PROJECT_TTL_MS)).toBe(rows)
})

it('throttles opportunistic refreshes', () => {
  expect(shouldRefreshHarkProjects(0, HARK_PROJECTS_MIN_REFRESH_GAP_MS)).toBe(true)
  expect(shouldRefreshHarkProjects(10_000, 10_000 + HARK_PROJECTS_MIN_REFRESH_GAP_MS - 1)).toBe(false)
})
