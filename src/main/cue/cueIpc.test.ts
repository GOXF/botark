import { beforeEach, expect, it, vi } from 'vitest'
import { runCueRpc } from './cueIpc'

const fixture = vi.hoisted(() => ({
  roster: vi.fn(),
  agent: vi.fn(),
  history: vi.fn(),
  send: vi.fn()
}))
vi.mock('./cueAuth', () => ({
  loadCueTokens: async () => ({ accessToken: 'fixture' }),
  currentCueAuthForIdentity: (auth: unknown) => auth
}))
vi.mock('./cueClient', () => ({
  fetchCueAgents: fixture.roster,
  fetchCueAgentById: fixture.agent,
  fetchCueSessionHistory: fixture.history
}))
vi.mock('./cueChatSocket', () => ({ sendCueNativeMessage: fixture.send }))

beforeEach(() => {
  vi.clearAllMocks()
  fixture.agent.mockResolvedValue(null)
  fixture.roster.mockResolvedValue({ ok: true, agents: [{ id: 'first', sessionId: 'wrong' }] })
})

it('does not use another agent session for history or sends', async () => {
  const target = { accountId: 'cue-fixture', agentId: 'named' }
  await expect(runCueRpc({ ...target, op: 'getHistory' })).resolves.toMatchObject({ ok: false, status: 404 })
  await expect(runCueRpc({ ...target, op: 'sendMessage', text: 'Fixture' })).resolves.toMatchObject({ ok: false, status: 404 })
  expect(fixture.history).not.toHaveBeenCalled()
  expect(fixture.send).not.toHaveBeenCalled()
})

it('uses an exact roster match when agent detail is unavailable', async () => {
  fixture.roster.mockResolvedValue({ ok: true, agents: [{ id: 'first', sessionId: 'wrong' }, { id: 'named', sessionId: 'right' }] })
  fixture.history.mockResolvedValue({ messages: [] })
  await expect(runCueRpc({ accountId: 'cue-fixture', agentId: 'named', op: 'getHistory' }))
    .resolves.toMatchObject({ ok: true, data: { sessionId: 'right' } })
  expect(fixture.history).toHaveBeenCalledWith('cue-fixture', 'right', expect.anything())
})
