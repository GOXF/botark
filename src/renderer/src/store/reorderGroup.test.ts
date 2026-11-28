import { describe, expect, it } from 'vitest'
import { useBotStore } from './botStore'

const ids = () => useBotStore.getState().groups.map((g) => g.id)
const seed = () => useBotStore.setState({ groups: ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id })) })

describe('reorderGroup', () => {
  it('moves a section before another, to the end, and ignores no-ops', () => {
    const { reorderGroup } = useBotStore.getState()
    seed()
    reorderGroup('c', 'a')
    expect(ids()).toEqual(['c', 'a', 'b', 'd'])
    reorderGroup('c', null)
    expect(ids()).toEqual(['a', 'b', 'd', 'c'])
    reorderGroup('a', 'c')
    expect(ids()).toEqual(['b', 'd', 'a', 'c'])
    const before = useBotStore.getState().groups
    reorderGroup('a', 'a')
    reorderGroup('a', 'c')
    reorderGroup('missing', 'b')
    expect(useBotStore.getState().groups).toBe(before)
  })
})
