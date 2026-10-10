import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On, SessionUsage } from 'claude-code'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120 },
} as const

const T0 = Date.parse('2026-10-10T16:00:00+08:00')
const TURN = {
  answer: 'ok', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer',
  usage: { model: 'x', input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
} as const

type UI = { findAll: (q: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }
const textOf = async (ui: UI) => (await ui.findAll({ type: 'Text' })).map(t => t.text).join('|')
const altOf = async (ui: UI) => (await ui.findAll({ type: 'Svg' })).map(t => String(t.props.alt)).join('|')
const svgOf = async (ui: UI) => (await ui.findAll({ type: 'Svg' })).map(t => String(t.props.source)).join('')

function subscriber(percent: number): SessionUsage {
  return {
    startedAt: 0,
    context: { window: 200_000, tokens: 124_000, percent },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 41, resetsAt: new Date(T0 + 150 * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 23 },
    ],
    cost: { usd: 1.23 },
  }
}

/** 測試底下代替模型回應 */
function answerSteps(on: On) {
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
}

/** 測試底下代替引擎：引擎自己在輸入框上方什麼都不畫 */
function engineBand(on: On) {
  on('ui.render', () => ({ type: 'engine', ref: 'core' }) as never)
}

/** 主對話（或子代理）送出一次模型請求 */
async function step($: EngineInterface, agentId?: string) {
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'x', messageCount: 1, ...(agentId ? { agentId } : {}) })) {
    // 讀完整個串流
  }
}

test('desktop: drawn as SVG segments with every figure; >80% bar and number turn red', async ($, on) => {
  mock.clock(on, { now: T0 })
  answerSteps(on)
  engineBand(on)
  let usage = subscriber(62)
  on('session.usage', () => ({ value: usage }))
  on('turn.complete', () => ({ text: '' }))
  await step($)
  await $.turn.complete(TURN)

  let ui = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
  const alt = await altOf(ui)
  for (const s of ['context 62%', '5 小時 41%，2:30 重置', '本週 23%', '快取 60:00']) expect(alt).toContain(s)
  expect(alt).not.toContain('花費')
  expect(await svgOf(ui)).not.toContain('#f87171')
  await ui.unmount()

  usage = subscriber(85)
  await $.turn.complete({ ...TURN, turnId: 't2' })
  ui = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
  const ctx = (await ui.findAll({ type: 'Svg' })).find(s => String(s.props.alt).startsWith('context'))
  expect(String(ctx?.props.source)).toContain('#f87171')
})

test('terminal: text version with every figure', async ($, on) => {
  mock.clock(on, { now: T0 })
  answerSteps(on)
  engineBand(on)
  on('session.usage', () => ({ value: subscriber(62) }))
  on('turn.complete', () => ({ text: '' }))
  await step($)
  await $.turn.complete(TURN)
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', ...BAND })
  const all = await textOf(ui)
  for (const s of ['context', '62%', '5 小時', '41%', '2:30 重置', '本週', '23%', '快取', '60:00']) expect(all).toContain(s)
})

test('沒有額度資料時只顯示 context，不顯示花費', async ($, on) => {
  mock.clock(on, { now: T0 })
  answerSteps(on)
  engineBand(on)
  on('session.usage', () => ({ value: {
    startedAt: 0,
    context: { window: 200_000, tokens: 20_000, percent: 10 },
    rateLimits: [],
    cost: { usd: 0.4567 },
  } }))
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete(TURN)
  const desk = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
  const alt = await altOf(desk)
  expect(alt).toContain('context 10%')
  expect(alt).not.toContain('花費')
  expect(alt).not.toContain('5 小時')
  await desk.unmount()
  const term = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', ...BAND })
  expect(await textOf(term)).not.toContain('花費')
  expect(await textOf(term)).not.toContain('$')
})

test('快取：主對話請求開始倒數，剩五分鐘變黃，過期變紅，子代理不算', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  answerSteps(on)
  engineBand(on)
  on('session.usage', () => ({ value: subscriber(10) }))
  on('turn.complete', () => ({ text: '' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await step($)
  await $.turn.complete(TURN)

  const cache = async () => {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', ...BAND })
    const texts = await ui.findAll({ type: 'Text' })
    await ui.unmount()
    const i = texts.findIndex(t => t.text === '快取')
    return texts[i + 1]
  }

  await clock.advance(10 * 60_000)
  await step($, 'agent-1')
  expect((await cache())?.text).toBe('50:00')

  await clock.advance(46 * 60_000)
  const soon = await cache()
  expect(soon?.text).toBe('04:00')
  expect(soon?.props.color).toBe('warning')

  await clock.advance(5 * 60_000)
  const gone = await cache()
  expect(gone?.text).toBe('已過期，下一句會重新計算')
  expect(gone?.props.color).toBe('error')

  await step($)
  expect((await cache())?.text).toBe('60:00')
})

type Boxes = { findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }
const wraps = async (ui: Boxes) => (await ui.findAll({ type: 'Box' })).some(b => b.props.flexWrap === 'wrap')

test('固定一行：終端機太窄時先丟重置倒數、本週、5 小時，context 和快取永遠留著', async ($, on) => {
  mock.clock(on, { now: T0 })
  answerSteps(on)
  engineBand(on)
  on('session.usage', () => ({ value: subscriber(62) }))
  on('turn.complete', () => ({ text: '' }))
  await step($)
  await $.turn.complete(TURN)

  const narrow = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: 60 } })
  const all = await textOf(narrow)
  expect(await wraps(narrow)).toBe(false)
  for (const s of ['context', '62%', '快取', '60:00']) expect(all).toContain(s)
  expect(all).not.toContain('重置')
  await narrow.unmount()

  const desk = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
  expect(await wraps(desk)).toBe(false)
})

test('別的模組也畫在輸入框上方時，併進同一行', async ($, on) => {
  mock.clock(on, { now: T0 })
  answerSteps(on)
  on('ui.render', ($, e) => {
    const { Button } = $.ui.resolve(e)
    return <Button key="other" label="交接到新對話" onPress={() => {}} />
  })
  on('session.usage', () => ({ value: subscriber(62) }))
  on('turn.complete', () => ({ text: '' }))
  await step($)
  await $.turn.complete(TURN)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    expect(await ui.find({ key: 'other' })).toBeDefined()
    expect(await wraps(ui)).toBe(false)
    await ui.unmount()
  }
})
