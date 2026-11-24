import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ANTIGRAVITY_ORIGIN,
  buildSapisidAuthHeader,
  buildSendUserCascadeMessageReq,
  buildStartCascadeReq,
  CASCADE_RUN_STATUS,
  cleanAntigravityChromeUserAgent,
  CORTEX_STEP_STATUS,
  CORTEX_STEP_TYPE,
  extractTranscriptFromSteps,
  extractTurnProgress,
  findAntigravityTurn,
  isAllowedAntigravityUrl,
  JspbStreamBodyParser,
  mergeTrajectorySteps,
  parseAgentStateUpdate,
  parseAvailableModels,
  parseConversationsList,
  parseUserProfile,
  type AntigravityParsedStep
} from './antigravityProtocol'

const fetchRpc = vi.hoisted(() => vi.fn<(_url: string, _opts: RequestInit) => Promise<Response>>())
vi.mock('electron', () => ({
  session: { fromPartition: () => ({
    fetch: fetchRpc,
    getUserAgent: () => '', setUserAgent: () => undefined,
    cookies: { get: async () => [{ name: 'SAPISID', value: 'fixture-cookie' }] }
  }) }
}))
vi.mock('../muse/accountProxy', () => ({ applyProxyToPartition: async () => undefined }))
vi.mock('../webContentsViewManager', () => ({ partitionForAccount: (id: string) => id }))

describe('antigravityProtocol auth & URL helpers', () => {
  it('computes SAPISIDHASH, SAPISID1PHASH, and SAPISID3PHASH headers deterministically', () => {
    const header = buildSapisidAuthHeader(
      [
        { name: 'SAPISID', value: 'cookie-main' },
        { name: '__Secure-1PAPISID', value: 'cookie-1p' },
        { name: '__Secure-3PAPISID', value: 'cookie-3p' }
      ],
      ANTIGRAVITY_ORIGIN,
      1700000000
    )
    expect(header).toBeTruthy()
    const parts = header!.split(' ')
    expect(parts).toHaveLength(6)
    expect(parts[0]).toBe('SAPISIDHASH')
    expect(parts[2]).toBe('SAPISID1PHASH')
    expect(parts[4]).toBe('SAPISID3PHASH')
    expect(parts[1]).toMatch(/^1700000000_[0-9a-f]{40}$/)
    expect(parts[3]).toMatch(/^1700000000_[0-9a-f]{40}$/)
    expect(parts[5]).toMatch(/^1700000000_[0-9a-f]{40}$/)
  })

  it('returns null when no SAPISID cookies are present', () => {
    expect(buildSapisidAuthHeader([{ name: 'NID', value: 'abc' }])).toBeNull()
  })

  it('validates allowed Google/Antigravity URLs and rejects lookalikes', () => {
    expect(isAllowedAntigravityUrl('https://antigravity.google.com/')).toBe(true)
    expect(isAllowedAntigravityUrl('https://accounts.google.com/ServiceLogin')).toBe(true)
    expect(isAllowedAntigravityUrl('https://aicode.clients6.google.com/')).toBe(true)
    expect(isAllowedAntigravityUrl('about:blank')).toBe(true)
    expect(isAllowedAntigravityUrl('https://evilgoogle.com/')).toBe(false)
    expect(isAllowedAntigravityUrl('javascript:alert(1)')).toBe(false)
  })

  it('strips Electron and BotArk tokens from UA', () => {
    const cleaned = cleanAntigravityChromeUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) BotArk/0.9.0 Chrome/136.0.0.0 Electron/36.2.1 Safari/537.36'
    )
    expect(cleaned).not.toContain('Electron/')
    expect(cleaned).not.toContain('BotArk/')
    expect(cleaned).toContain('Chrome/136.0.0.0')
  })
})

describe('antigravityProtocol JSPB builders & parsers', () => {
  it('builds StartCascadeRequest and SendUserCascadeMessageRequest with exact field positions', () => {
    const start = buildStartCascadeReq({
      text: 'Hello Antigravity',
      modelEnum: 42,
      capsuleId: 'cap-1',
      clientMessageId: 'msg-1'
    })
    expect(start[1]).toBe('Hello Antigravity') // field 2: initialPrompt
    expect(start[4]).toEqual([['cap-1']]) // field 5: environment.capsule.capsuleId
    expect(start[5]).toEqual([42]) // field 6: configOverrides.model
    expect(start[6]).toEqual([['Hello Antigravity']]) // field 7: items
    expect(start[13]).toBe('msg-1') // field 14: clientMessageId

    const send = buildSendUserCascadeMessageReq({
      cascadeId: 'cas-99',
      text: 'Follow up',
      modelEnum: 7,
      continueExecution: true,
      clientMessageId: 'msg-2'
    })
    expect(send[0]).toBe('cas-99') // field 1
    expect(send[1]).toBe('Follow up') // field 2
    expect(send[3]).toEqual([['Follow up']]) // field 4
    expect(send[5]).toBe(true) // field 6
    expect(send[6]).toEqual([7]) // field 7
    expect(send[12]).toBe('msg-2') // field 13
  })

  it('parses UserProfile, Models, and ConversationsList', () => {
    const profile = parseUserProfile(['alice@example.com', ['pro', 'Google AI Pro']])
    expect(profile).toEqual({
      email: 'alice@example.com',
      planId: 'pro',
      planDisplayName: 'Google AI Pro'
    })

    const models = parseAvailableModels([
      [
        [101, 'Gemini 3.5 Pro', 'Best for coding', true, [0.85, [1795000000, 0]], 'gemini-3.5-pro'],
        [102, 'Gemini 3.5 Flash', 'Fast', false, null, 'gemini-3.5-flash']
      ]
    ])
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({
      modelEnum: 101,
      modelId: 'gemini-3.5-pro',
      displayName: 'Gemini 3.5 Pro',
      isDefault: true,
      remainingFraction: 0.85
    })

    const list = parseConversationsList([
      [
        [
          'Build mobile sync',
          12,
          [1795000100, 0],
          'conv-abc',
          CASCADE_RUN_STATUS.IDLE,
          null,
          [1795000000, 0]
        ]
      ],
      'next-tok'
    ])
    expect(list.nextPageToken).toBe('next-tok')
    expect(list.conversations[0]).toMatchObject({
      conversationId: 'conv-abc',
      title: 'Build mobile sync',
      stepCount: 12,
      statusLabel: 'idle'
    })
  })

  it('merges trajectory steps and extracts transcript & live turn progress', () => {
    const userStep: unknown[] = []
    userStep[0] = CORTEX_STEP_TYPE.USER_INPUT
    userStep[3] = CORTEX_STEP_STATUS.DONE
    userStep[18] = ['Write tests', 'Write tests'] // field 19: UserInput

    const toolStep: unknown[] = []
    toolStep[0] = CORTEX_STEP_TYPE.RUN_COMMAND
    toolStep[3] = CORTEX_STEP_STATUS.DONE
    const toolMeta: unknown[] = []
    toolMeta[29] = 'Run vitest' // field 30: toolSummary
    toolStep[4] = toolMeta

    const replyStep: unknown[] = []
    replyStep[0] = CORTEX_STEP_TYPE.PLANNER_RESPONSE
    replyStep[3] = CORTEX_STEP_STATUS.DONE
    replyStep[19] = ['All tests passed!', null, 'Checking assertions'] // field 20: PlannerResponse

    const rawUpdate: unknown[] = []
    rawUpdate[0] = 'conv-1'
    rawUpdate[1] = 'traj-1'
    rawUpdate[2] = CASCADE_RUN_STATUS.IDLE
    rawUpdate[6] = [[[0, 1, 2], [userStep, toolStep, replyStep], 3]]
    rawUpdate[17] = true

    const parsed = parseAgentStateUpdate(rawUpdate, 'res-1')
    expect(parsed).toBeTruthy()
    const map = new Map()
    mergeTrajectorySteps(map, parsed!)

    const transcript = extractTranscriptFromSteps(map, 'conv-1')
    expect(transcript).toHaveLength(2)
    expect(transcript[0]).toMatchObject({ role: 'user', text: 'Write tests' })
    expect(transcript[1]).toMatchObject({ role: 'assistant', text: 'All tests passed!' })
    expect(transcript[1].tools?.[0]?.name).toBe('Run vitest')

    const progress = extractTurnProgress(map, 0)
    expect(progress.text).toBe('All tests passed!')
    expect(progress.tools).toHaveLength(1)
  })

  it('extracts a reply only between its matching user step and the next user step', () => {
    const step = (index: number, type: number, data: Partial<AntigravityParsedStep>): AntigravityParsedStep => ({
      index, type, status: CORTEX_STEP_STATUS.DONE, createdAtMs: 0, ...data
    })
    const steps = new Map([
      step(1, CORTEX_STEP_TYPE.USER_INPUT, { userText: 'same prompt', clientMessageId: 'old' }),
      step(2, CORTEX_STEP_TYPE.PLANNER_RESPONSE, { assistantText: 'old response' }),
      step(5, CORTEX_STEP_TYPE.USER_INPUT, { userText: 'same prompt', clientMessageId: 'current' }),
      step(6, CORTEX_STEP_TYPE.PLANNER_RESPONSE, { assistantText: 'current response' }),
      step(9, CORTEX_STEP_TYPE.USER_INPUT, { clientMessageId: 'later' }),
      step(10, CORTEX_STEP_TYPE.PLANNER_RESPONSE, { assistantText: 'later response' })
    ].map((value) => [value.index, value]))
    expect(findAntigravityTurn(steps, 'unknown')).toBeUndefined()
    const turn = findAntigravityTurn(steps, 'current')!
    expect(turn).toEqual({ userStepIndex: 5, nextUserStepIndex: 9 })
    expect(extractTurnProgress(steps, turn.userStepIndex, turn.nextUserStepIndex).text).toBe('current response')
  })
})

describe('JspbStreamBodyParser', () => {
  it('parses chunked StreamBody messages and trailing RpcStatus incrementally', () => {
    const parser = new JspbStreamBodyParser()
    const e1 = parser.push('[[[["conv-1","msg [with] brackets"],"tok1"],')
    expect(e1).toHaveLength(1)
    expect(e1[0]).toEqual({ kind: 'message', payload: [['conv-1', 'msg [with] brackets'], 'tok1'] })

    const e2 = parser.push('[["conv-1","done"],"tok2"]],[0,"OK"]]')
    expect(e2).toHaveLength(2)
    expect(e2[0]).toEqual({ kind: 'message', payload: [['conv-1', 'done'], 'tok2'] })
    expect(e2[1]).toEqual({ kind: 'status', code: 0, message: 'OK' })
    expect(() => parser.finish()).not.toThrow()
  })

  it('preserves a terminal gRPC error after a message in the same chunk', () => {
    const parser = new JspbStreamBodyParser()
    expect(parser.push('[[["last update"]],[7,"Permission denied"]]')).toEqual([
      { kind: 'message', payload: ['last update'] },
      { kind: 'status', code: 7, message: 'Permission denied' }
    ])
    parser.finish()
  })

  it('rejects truncated and oversized unfinished frames', () => {
    const truncated = new JspbStreamBodyParser()
    truncated.push('[[["abc')
    expect(() => truncated.finish()).toThrow('Truncated')

    const missingWrapper = new JspbStreamBodyParser()
    missingWrapper.push('[[["abc"]],[0,"OK"]')
    expect(() => missingWrapper.finish()).toThrow('Truncated')

    const oversized = new JspbStreamBodyParser(16)
    oversized.push('[[["partial')
    expect(() => oversized.push(' frame spilling over the limit')).toThrow('size limit')
  })
})

describe('Antigravity turn streaming', () => {
  afterEach(() => {
    fetchRpc.mockReset()
    vi.unstubAllGlobals()
  })

  it.each([7, 0])('verifies the trailing gRPC status (%s) and releases the stream reader', async (status) => {
    const { sendAndStreamAntigravityMessage } = await import('./antigravityClient')
    const messageId = 'client-message-id'
    const input: unknown[] = [CORTEX_STEP_TYPE.USER_INPUT]
    const userInput: unknown[] = ['Same prompt']
    userInput[18] = messageId
    input[18] = userInput
    const reply: unknown[] = [CORTEX_STEP_TYPE.PLANNER_RESPONSE]
    reply[19] = ['Partial reply']
    const update: unknown[] = ['cascade', 'trajectory', CASCADE_RUN_STATUS.IDLE]
    update[6] = [[[0, 1], [input, reply], 2]]

    const cancelReader = vi.fn()
    const releaseReader = vi.fn()
    const frames = [
      new TextEncoder().encode(JSON.stringify([[[update]], [status, status ? 'Permission denied' : 'OK']]))
    ]
    fetchRpc.mockResolvedValueOnce(Response.json(['cascade']))
    fetchRpc.mockResolvedValueOnce({
      ok: true,
      headers: new Headers(),
      body: { getReader: () => ({
        read: async () => {
          const value = frames.shift()
          return { done: !value, value }
        },
        cancel: async () => { cancelReader() },
        releaseLock: releaseReader
      }) }
    } as unknown as Response)
    const events = vi.fn<(_event: import('./antigravityProtocol').AntigravityTurnEvent) => void>()
    expect(await sendAndStreamAntigravityMessage({
      accountId: 'account', conversationId: 'bot', clientMessageId: messageId, text: 'Same prompt', onEvent: events
    })).toEqual({ cascadeId: 'cascade', messageId })
    await vi.waitFor(() => expect(events.mock.lastCall?.[0]).toMatchObject(status ? {
      type: 'stream', messageId, done: true, text: '', error: { status: 403, message: 'Permission denied' }
    } : { type: 'stream', messageId, done: true, text: 'Partial reply' }))
    expect(events.mock.calls.every(([event]) => event.messageId === messageId)).toBe(true)
    expect(cancelReader).toHaveBeenCalledOnce()
    expect(releaseReader).toHaveBeenCalledOnce()
    expect(fetchRpc).toHaveBeenCalledTimes(2)
  })
})
