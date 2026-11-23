import { describe, expect, it } from 'vitest'
import { avoidNotice } from './noticeRect'

const view = { x: 0, y: 100, width: 1000, height: 800 }
describe('avoidNotice', () => {
  it('leaves the view alone without a notice or overlap', () => {
    expect(avoidNotice(view, null)).toEqual(view)
    expect(avoidNotice(view, { x: 1100, y: 800, width: 340, height: 60 })).toEqual(view)
  })
  it('ends the view above an overlapping notice', () => {
    expect(avoidNotice(view, { x: 650, y: 820, width: 340, height: 60 })).toEqual({ ...view, height: 712 })
  })
})
