/** GOXF 任务流水线 (Issue #5): a task card moves 需求→分配→开发→Review→人工确认→上线. */
export type Stage = 'need' | 'assign' | 'dev' | 'review' | 'confirm' | 'live'

export const STAGES: ReadonlyArray<{ id: Stage; label: string; gate?: true }> = [
  { id: 'need', label: '需求' },
  { id: 'assign', label: '分配' },
  { id: 'dev', label: '开发' },
  { id: 'review', label: 'Review', gate: true },
  { id: 'confirm', label: '人工确认', gate: true },
  { id: 'live', label: '上线' }
]

/** Who does the work: one bot, or a whole group chat. */
export interface Executor {
  kind: 'bot' | 'room'
  id: string
  name: string
}

export interface Suggestion {
  executor?: Executor
  plan: string[]
}

export interface Reject {
  stage: 'review' | 'confirm'
  reason: string
  at: number
}

export interface PipelineTask {
  id: string
  num: number
  title: string
  detail: string
  stage: Stage
  executor?: Executor
  suggestion?: Suggestion
  /** Group chat whose [FINAL] feeds the Review gate. */
  reviewRoomId?: string
  /** Development round, 1-based; each 打回 starts the next. */
  round: number
  rejects: Reject[]
  output?: string
  review?: string
  /** Set when the user confirmed 上线 in the 上线 column. */
  releasedAt?: number
  createdAt: number
  updatedAt: number
}

export function newTask(id: string, num: number, title: string, detail: string, now: number, reviewRoomId?: string): PipelineTask {
  return { id, num, title: title.trim(), detail: detail.trim(), stage: 'need', round: 1, rejects: [], reviewRoomId, createdAt: now, updatedAt: now }
}

// Every transition returns the task unchanged when it does not apply to its stage.

export function toAssign(task: PipelineTask, suggestion: Suggestion | undefined, now: number): PipelineTask {
  return task.stage === 'need' ? { ...task, stage: 'assign', suggestion, updatedAt: now } : task
}

export function assign(task: PipelineTask, executor: Executor, now: number): PipelineTask {
  return task.stage === 'assign' ? { ...task, stage: 'dev', executor, updatedAt: now } : task
}

export function submitDev(task: PipelineTask, output: string | undefined, now: number): PipelineTask {
  return task.stage === 'dev' ? { ...task, stage: 'review', output, review: undefined, updatedAt: now } : task
}

export function setReview(task: PipelineTask, review: string, now: number): PipelineTask {
  return task.stage === 'review' ? { ...task, review, updatedAt: now } : task
}

/** 通过 at a gate: Review → 人工确认 → 上线 (waiting for the release confirm). */
export function pass(task: PipelineTask, now: number): PipelineTask {
  if (task.stage === 'review') return { ...task, stage: 'confirm', updatedAt: now }
  if (task.stage === 'confirm') return { ...task, stage: 'live', updatedAt: now }
  return task
}

/** 打回 at a gate: back to 开发 as the next round, carrying the one-line reason. */
export function reject(task: PipelineTask, reason: string, now: number): PipelineTask {
  const line = reason.trim()
  if (!line || (task.stage !== 'review' && task.stage !== 'confirm')) return task
  return {
    ...task,
    stage: 'dev',
    round: task.round + 1,
    rejects: [...task.rejects, { stage: task.stage, reason: line, at: now }],
    updatedAt: now
  }
}

export function release(task: PipelineTask, now: number): PipelineTask {
  return task.stage === 'live' && !task.releasedAt ? { ...task, releasedAt: now, updatedAt: now } : task
}

/** Cards that wait on the user: 只看要我处理的. */
export function needsMe(task: PipelineTask): boolean {
  return task.stage === 'assign' || task.stage === 'review' || task.stage === 'confirm' || (task.stage === 'live' && !task.releasedAt)
}

export function lastReject(task: PipelineTask): Reject | undefined {
  return task.rejects[task.rejects.length - 1]
}

/** Message sent to the executor when a round starts. */
export function devPrompt(task: PipelineTask): string {
  const back = lastReject(task)
  return [
    `任务 #${task.num}：${task.title}`,
    task.detail,
    task.suggestion?.plan.length ? `拆分：\n${task.suggestion.plan.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '',
    back ? `第 ${task.round} 轮（${back.stage === 'review' ? 'Review' : '人工确认'}打回）：${back.reason}` : '',
    '完成后以 [FINAL] 开头给出交付说明。'
  ].filter(Boolean).join('\n\n')
}

/** Brief for the administrator: split only, name an executor, mention nobody. */
export function splitPrompt(task: PipelineTask, candidates: ReadonlyArray<Executor>): string {
  return [
    `只做拆分和建议执行者，不要派活，不要 @ 任何人。新需求 #${task.num}：${task.title}`,
    task.detail,
    `可选执行者：${candidates.map((c) => c.name).join('、')}`,
    '按这个格式以 [FINAL] 开头回复：\n[FINAL]\n执行者：名字\n拆分：\n1. …\n2. …'
  ].filter(Boolean).join('\n\n')
}

/** Read the administrator's reply: the executor it names and the numbered steps. */
export function parseSuggestion(text: string, candidates: ReadonlyArray<Executor>): Suggestion {
  const byLength = [...candidates].filter((c) => c.name.trim()).sort((a, b) => b.name.length - a.name.length)
  const line = /执行者\s*[:：]\s*(.+)/.exec(text)?.[1] ?? ''
  const executor = byLength.find((c) => line.includes(c.name)) ?? byLength.find((c) => text.includes(c.name))
  const plan = text
    .split('\n')
    .map((l) => /^\s*(?:\d+[.、)]|[-*•])\s*(.+)$/.exec(l)?.[1]?.trim())
    .filter((s): s is string => Boolean(s))
  return { executor, plan }
}
