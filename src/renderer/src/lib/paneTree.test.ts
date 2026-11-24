import { describe, expect, it } from 'vitest'
import {
  PANE_GAP,
  PANE_MIN_W,
  closeLeaf,
  equalize,
  layoutRects,
  leaf,
  leaves,
  minSize,
  pruneBots,
  ratioBounds,
  splitLeaf,
  splitResult,
  type PaneSplit
} from './paneTree'

const box = { x: 0, y: 0, w: 1300, h: 900 }

describe('paneTree', () => {
  it('splits a leaf to the right and keeps the original first', () => {
    const t = splitLeaf(leaf('a', 'L1'), 'L1', 'right', 'b', 'L2')
    expect(t.type).toBe('split')
    expect(leaves(t).map((l) => l.botId)).toEqual(['a', 'b'])
    expect((t as PaneSplit).dir).toBe('row')
  })

  it('splits left/top puts the new leaf first, bottom makes a column', () => {
    expect(leaves(splitLeaf(leaf('a', 'L1'), 'L1', 'left', 'b', 'L2')).map((l) => l.botId)).toEqual(['b', 'a'])
    expect((splitLeaf(leaf('a', 'L1'), 'L1', 'bottom', 'b') as PaneSplit).dir).toBe('col')
  })

  it('nests without a cap and lays out every leaf', () => {
    let t = splitLeaf(leaf('a', 'L1'), 'L1', 'right', 'b', 'L2')
    t = splitLeaf(t, 'L2', 'bottom', 'c', 'L3')
    t = splitLeaf(t, 'L1', 'right', 'd', 'L4')
    expect(leaves(t)).toHaveLength(4)
    const rects = layoutRects(t, box)
    expect(Object.keys(rects)).toHaveLength(4)
    expect(rects.L2!.h + rects.L3!.h + PANE_GAP).toBeCloseTo(900)
  })

  it('refuses a split that would make panes narrower than 360px', () => {
    const t = splitLeaf(leaf('a', 'L1'), 'L1', 'right', 'b', 'L2')
    // each half 646 → splitting again gives 319 < 360
    expect(splitResult(t, box, 'L2', 'right').ok).toBe(false)
    expect(splitResult(t, box, 'L2', 'right').size).toBeLessThan(PANE_MIN_W)
    expect(splitResult(t, box, 'L2', 'bottom').ok).toBe(true)
    expect(splitResult(leaf('a', 'L1'), box, 'L1', 'right').ok).toBe(true)
  })

  it('closing a leaf promotes its sibling; the last leaf only empties', () => {
    const t = splitLeaf(leaf('a', 'L1'), 'L1', 'right', 'b', 'L2')
    const c = closeLeaf(t, 'L2')
    expect(c).toEqual({ type: 'leaf', id: 'L1', botId: 'a' })
    expect(closeLeaf(c, 'L1')).toEqual({ type: 'leaf', id: 'L1', botId: null })
  })

  it('min size adds up rows and stacks columns', () => {
    let t = splitLeaf(leaf('a', 'L1'), 'L1', 'right', 'b', 'L2')
    t = splitLeaf(t, 'L2', 'bottom', 'c', 'L3')
    expect(minSize(t).w).toBe(PANE_MIN_W * 2 + PANE_GAP)
  })

  it('divider bounds keep both sides at the minimum', () => {
    const t = splitLeaf(leaf('a', 'L1'), 'L1', 'right', 'b', 'L2') as PaneSplit
    const [lo, hi] = ratioBounds(t, 1000)
    expect(lo * (1000 - PANE_GAP)).toBeCloseTo(PANE_MIN_W)
    expect((1 - hi) * (1000 - PANE_GAP)).toBeCloseTo(PANE_MIN_W)
    expect(ratioBounds(t, 500)).toEqual([0.5, 0.5])
  })

  it('equalize gives three columns a third each', () => {
    let t = splitLeaf(leaf('a', 'L1'), 'L1', 'right', 'b', 'L2')
    t = splitLeaf(t, 'L2', 'right', 'c', 'L3')
    const rects = layoutRects(equalize(t), box)
    expect(Math.abs(rects.L1!.w - rects.L2!.w)).toBeLessThan(PANE_GAP)
    expect(rects.L2!.w).toBeCloseTo(rects.L3!.w)
  })

  it('prune empties panes of deleted bots', () => {
    const t = splitLeaf(leaf('a', 'L1'), 'L1', 'right', 'b', 'L2')
    expect(leaves(pruneBots(t, (id) => id !== 'b')).map((l) => l.botId)).toEqual(['a', null])
  })
})
