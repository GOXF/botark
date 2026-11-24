import { describe, expect, it } from 'vitest'
import {
  PANE_GAP,
  PANE_MIN_W,
  closeLeaf,
  equalize,
  layoutRects,
  leaf,
  leaves,
  leafBot,
  minSize,
  moveTab,
  openTab,
  pruneBots,
  readPaneNode,
  closeTab,
  findBot,
  findTab,
  showInLeaf,
  tab,
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
    expect(leaves(t).map(leafBot)).toEqual(['a', 'b'])
    expect((t as PaneSplit).dir).toBe('row')
  })

  it('splits left/top puts the new leaf first, bottom makes a column', () => {
    expect(leaves(splitLeaf(leaf('a', 'L1'), 'L1', 'left', 'b', 'L2')).map(leafBot)).toEqual(['b', 'a'])
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
    expect(c.type === 'leaf' && c.id === 'L1' && leafBot(c)).toBe('a')
    expect(closeLeaf(c, 'L1')).toEqual({ type: 'leaf', id: 'L1', tabs: [], active: null })
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
    expect(leaves(pruneBots(t, (id) => id !== 'b')).map(leafBot)).toEqual(['a', null])
  })

  describe('tabs', () => {
    const two = () => openTab(leaf(tab('a', undefined, 'A'), 'L1'), 'L1', tab('b', undefined, 'B'))

    it('opens a tab after the active one and shows it; an identical tab is just shown', () => {
      const t = two()
      expect(t.type === 'leaf' && t.tabs.map((x) => x.id)).toEqual(['A', 'B'])
      expect(t.type === 'leaf' && t.active).toBe('B')
      const again = openTab(t, 'L1', tab('a'))
      expect(again.type === 'leaf' && again.tabs).toHaveLength(2)
      expect(again.type === 'leaf' && again.active).toBe('A')
    })

    it('closing the active tab shows its neighbour; the last tab of a pane closes the pane', () => {
      const t = closeTab(two(), 'L1', 'B')
      expect(t.type === 'leaf' && t.active).toBe('A')
      const s = splitLeaf(t, 'L1', 'right', 'c', 'L2')
      const c = closeTab(s, 'L2', leaves(s)[1]!.active!)
      expect(leaves(c).map((l) => l.id)).toEqual(['L1'])
      // the very last pane only empties
      expect(closeTab(c, 'L1', 'A')).toEqual({ type: 'leaf', id: 'L1', tabs: [], active: null })
    })

    it('sidebar click swaps the active tab, or shows a tab of that bot already in the pane', () => {
      const t = showInLeaf(two(), 'L1', 'c')
      expect(t.type === 'leaf' && t.tabs.map((x) => x.botId)).toEqual(['a', 'c'])
      const back = showInLeaf(t, 'L1', 'a')
      expect(back.type === 'leaf' && back.active).toBe('A')
    })

    it('moves a tab into another pane, or to its edge; an emptied pane closes', () => {
      const s = splitLeaf(two(), 'L1', 'right', tab('c', undefined, 'C'), 'L2')
      const joined = moveTab(s, 'L1', 'B', 'L2', 'center')
      expect(leaves(joined.tree).map((l) => l.tabs.map((x) => x.id))).toEqual([['A'], ['C', 'B']])
      expect(joined.leafId).toBe('L2')
      const emptied = moveTab(joined.tree, 'L1', 'A', 'L2', 'center')
      expect(leaves(emptied.tree)).toHaveLength(1)
      const edged = moveTab(s, 'L2', 'C', 'L1', 'bottom', 'L3')
      expect(leaves(edged.tree).map((l) => l.id)).toEqual(['L1', 'L3'])
      expect(leafBot(leaves(edged.tree)[1]!)).toBe('c')
    })

    it('a lone tab cannot split its own pane; dropping on its own middle does nothing', () => {
      const one = leaf(tab('a', undefined, 'A'), 'L1')
      expect(moveTab(one, 'L1', 'A', 'L1', 'right').tree).toBe(one)
      const t = two()
      expect(moveTab(t, 'L1', 'A', 'L1', 'center').tree).toBe(t)
      expect(leaves(moveTab(t, 'L1', 'A', 'L1', 'right', 'L2').tree).map(leafBot)).toEqual(['b', 'a'])
    })

    it('prune drops tabs of deleted bots and keeps the pane', () => {
      const p = pruneBots(two(), (id) => id !== 'b')
      expect(p.type === 'leaf' && p.tabs.map((x) => x.id)).toEqual(['A'])
      expect(p.type === 'leaf' && p.active).toBe('A')
    })
  })

  describe('Hark projects (bot + project identity)', () => {
    it('two panes can hold two projects of the same bot', () => {
      const t = splitLeaf(leaf(tab('h', 'P1', 'T1'), 'L1'), 'L1', 'right', tab('h', 'P2', 'T2'), 'L2')
      expect(findTab(t, 'h', 'P2')?.leaf.id).toBe('L2')
      expect(findTab(t, 'h', 'P1')?.leaf.id).toBe('L1')
      // unset project matches only unset tabs: a sidebar drag of the bot opens another pane
      expect(findTab(t, 'h')).toBeUndefined()
      // a sidebar click finds the bot in any pane
      expect(findBot(t, 'h')?.leaf.id).toBe('L1')
    })

    it('the same project joining a pane that already shows it is not duplicated', () => {
      const t = splitLeaf(leaf(tab('h', 'P1', 'T1'), 'L1'), 'L1', 'right', tab('h', 'P1', 'T2'), 'L2')
      const m = moveTab(t, 'L2', 'T2', 'L1', 'center')
      expect(leaves(m.tree)).toHaveLength(1)
      expect(leaves(m.tree)[0]!.tabs).toHaveLength(1)
    })
  })

  describe('restore', () => {
    it('upgrades a saved v13 layout (one bot per leaf) to tabs', () => {
      const old = { type: 'split', id: 's', dir: 'row', ratio: 0.5, a: { type: 'leaf', id: 'L1', botId: 'a' }, b: { type: 'leaf', id: 'L2', botId: null } }
      const t = readPaneNode(old)!
      expect(leaves(t).map(leafBot)).toEqual(['a', null])
      expect(leaves(t)[1]!.tabs).toEqual([])
    })

    it('round-trips tabs with projects and rejects junk', () => {
      const t = splitLeaf(two2(), 'L1', 'bottom', tab('h', 'P9', 'T9'), 'L2')
      expect(readPaneNode(JSON.parse(JSON.stringify(t)))).toEqual(t)
      expect(readPaneNode({ type: 'leaf', id: 'x', tabs: [{ id: 1 }] })).toBeNull()
      expect(readPaneNode(null)).toBeNull()
      // a stale active id falls back to the first tab
      const r = readPaneNode({ type: 'leaf', id: 'x', tabs: [{ id: 't', botId: 'a' }], active: 'gone' })
      expect(r?.type === 'leaf' && r.active).toBe('t')
    })

    function two2() {
      return openTab(leaf(tab('a', undefined, 'A'), 'L1'), 'L1', tab('h', 'P1', 'B'))
    }
  })
})
