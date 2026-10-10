import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On, TurnStepInput } from 'claude-code'

const START = 1_000_000_000

function setup($: EngineInterface, on: On) {
  const clock = mock.clock(on, { now: START })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return { clock, toasts }
}

async function step($: EngineInterface, agentId?: string) {
  const input: TurnStepInput = { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...(agentId ? { agentId } : {}) }
  for await (const _ of $.turn.step(input)) {
    // 讀完整個串流
  }
}

test('主對話的請求開始計時，剩五分鐘只提醒一次，送出下一句後重新計時', async ($, on) => {
  const { clock, toasts } = setup($, on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await clock.advance(70 * 60 * 1000)
  expect(toasts).toHaveLength(0)

  await step($)
  await clock.advance(54 * 60 * 1000)
  expect(toasts).toHaveLength(0)
  await clock.advance(2 * 60 * 1000)
  expect(toasts).toHaveLength(1)
  await clock.advance(10 * 60 * 1000)
  expect(toasts).toHaveLength(1)

  await step($)
  await clock.advance(56 * 60 * 1000)
  expect(toasts).toHaveLength(2)
})

test('子代理的請求不重新計時', async ($, on) => {
  const { clock, toasts } = setup($, on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await step($)
  await clock.advance(50 * 60 * 1000)
  await step($, 'agent-1')
  await clock.advance(6 * 60 * 1000)
  expect(toasts).toHaveLength(1)
})
