import { expect, test } from 'claude-code/testing'
import type { Engine, On } from 'claude-code/testing'

import { THRESHOLD } from '../hooks/register'

const props = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

const answered = {
  isAnswered: true,
  text: '## 目前的目標\n寫交接 mod',
  usage: { input_tokens: 1, output_tokens: 1 },
}

type Clickable = { pointer: (e: { type: 'down' | 'up'; x: number; y: number; button?: 'left' }) => Promise<void> }

/** 在膠囊中間按下再放開，跟真的滑鼠點一下一樣 */
const click = async (ui: Clickable) => {
  await ui.pointer({ type: 'down', x: 3, y: 0, button: 'left' })
  await ui.pointer({ type: 'up', x: 3, y: 0, button: 'left' })
}

const measure = ($: Engine, percent: number) =>
  $.session.measure({
    context: { tokens: percent * 2000, window: 200000, percent },
    rateLimits: [],
    changed: ['context'],
  })

const engineBeneath = (
  on: On,
  calls: string[],
  written: Record<string, string>,
  fork: unknown = answered,
) => {
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('model.fork', () => ({ value: fork }) as never)
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : undefined }) as never)
  on('session.cwd', () => ({ value: 'C:/proj' }) as never)
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 10, 3, 4, 5) }) as never)
  on('fs.write', ($, e) => {
    written[e.path] = e.text
    calls.push('write')
    return { value: undefined } as never
  })
  on('command.run', ($, e) => {
    calls.push(`/${e.command}`)
    return {}
  })
  on('prompt.submit', ($, e) => {
    calls.push(`submit:${e.text}`)
    return { text: e.text }
  })
  on('ui.toast', ($, e) => {
    calls.push(`toast:${JSON.stringify(e)}`)
    return { value: undefined } as never
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: 門檻以下不出現按鈕`, async ($, on) => {
    engineBeneath(on, [], {})
    await measure($, THRESHOLD - 1)
    const ui = await $.ui.mount({ plugin: 'context-handoff', surface, component: 'AbovePrompt', props })
    expect(await ui.find({ key: 'handoff' })).toBeUndefined()
  })

  test(`${surface}: 門檻以上按下按鈕會存檔、清空、送出摘要`, async ($, on) => {
    const calls: string[] = []
    const written: Record<string, string> = {}
    engineBeneath(on, calls, written)
    await measure($, THRESHOLD + 2)
    const ui = await $.ui.mount({ plugin: 'context-handoff', surface, component: 'AbovePrompt', props })
    expect(await ui.find({ key: 'handoff' })).toBeDefined()
    expect(JSON.stringify(await ui.drawn({ in: 'handoff' }))).toContain('#22c55e')

    await click(ui)

    const paths = Object.keys(written)
    expect(paths.length).toBe(1)
    expect(paths[0]).toMatch(/^C:[\\/]Users[\\/]me[\\/]\.claude[\\/]handoffs[\\/]handoff-\d{8}-\d{6}\.md$/)
    expect(written[paths[0]!]).toContain('寫交接 mod')
    expect(calls[0]).toBe('write')
    expect(calls[1]).toBe('/clear')
    expect(calls[2]).toContain('submit:')
    expect(calls[2]).toContain('寫交接 mod')
    expect(await ui.find({ key: 'handoff' })).toBeUndefined()
  })

  test(`${surface}: 摘要失敗時不清空對話`, async ($, on) => {
    const calls: string[] = []
    engineBeneath(on, calls, {}, { isAnswered: false, reason: 'nothing-to-fork' })
    await measure($, THRESHOLD + 10)
    const ui = await $.ui.mount({ plugin: 'context-handoff', surface, component: 'AbovePrompt', props })
    await click(ui)
    expect(calls.some(c => c === '/clear')).toBe(false)
  })
}
