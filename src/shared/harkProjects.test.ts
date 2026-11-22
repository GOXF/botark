import { expect, it } from 'vitest'
import { harkCreateProjectBody, harkProjects } from './harkProjects'

it('keeps the untitled main conversation distinct from archived projects', () => {
  expect(harkProjects({ conversations: [
    { id: 'main', title: null, archivedAt: null }, { id: 'project', title: 'Draft', archivedAt: 1 }
  ] })).toEqual([
    { id: 'main', title: '主会话', main: true, archived: false },
    { id: 'project', title: 'Draft', main: false, archived: true }
  ])
})

it('sends autoTitle and timezone when creating a project', () => {
  expect(harkCreateProjectBody(' 抖店运维 ', 'Asia/Shanghai')).toEqual({
    title: '抖店运维', timezone: 'Asia/Shanghai', autoTitle: false
  })
  expect(harkCreateProjectBody('', 'Asia/Shanghai')).toEqual({
    title: '新项目', timezone: 'Asia/Shanghai', autoTitle: true
  })
})
