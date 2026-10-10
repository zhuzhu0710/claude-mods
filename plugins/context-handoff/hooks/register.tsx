import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Phase } from '../types'

export const THRESHOLD = 70

const percent = atom({ plugin: 'context-handoff', key: 'percent' } as const, null)
const phase = atom({ plugin: 'context-handoff', key: 'phase' } as const, 'idle' as Phase)

export const SUMMARY_PROMPT = `請為這段對話寫一份「交接摘要」，讓一個完全沒看過這段對話的新對話能無縫接手。
用台灣繁體中文、Markdown 格式，只輸出摘要本身，不要前言或結語。依序包含以下段落：

## 目前的目標
使用者最終想完成什麼，以及目前進行到哪個階段。

## 已完成
已經做完的事項，具體到可以驗證。

## 尚未完成
還沒做的事項，依優先順序排列，寫出下一步該做什麼。

## 改過的檔案
每個建立、修改或刪除過的檔案的完整路徑，以及改了什麼。

## 注意事項
使用者的偏好與限制、已做過的決定與理由、踩過的坑、不要重做或不要碰的東西、相關指令。`

const pad = (n: number) => String(n).padStart(2, '0')

export const stamp = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

const handoff = async ($: EngineInterface) => {
  if ((await read($, phase)) !== 'idle') return
  await update($, phase, () => 'summarizing')

  try {
    const reply = await $.model.fork({ prompt: SUMMARY_PROMPT })
    if (!reply.isAnswered) {
      $.ui.toast(`交接摘要寫不出來（${reply.reason}），對話保持原樣`)
      return
    }

    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
    const cwd = await $.session.cwd()
    const path = `${home}/.claude/handoffs/handoff-${stamp(await $.clock.now())}.md`
    const summary = reply.text.trim()
    const body = `# 交接摘要\n\n> 工作目錄：${cwd}\n\n${summary}\n`
    await $.fs.write(path, body)

    await update($, phase, () => 'clearing')
    await $.command.run({ command: 'clear' })
    await update($, percent, () => null)

    await $.prompt.submit({
      text: `以下是上一段對話的交接摘要（已存於 ${path}），請先讀過並確認理解，然後從「尚未完成」的第一項接著做。\n\n${summary}`,
    })
  } catch (error) {
    $.ui.toast(`交接失敗：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await update($, phase, () => 'idle')
  }
}

export const register: Register = on => {
  // 膠囊按鈕（pill.tsx）被點擊時送來的訊息
  on('ui.message', async ($, e, next) => {
    const data = e.data as { action?: string } | null
    if (e.element !== 'handoff' || data?.action !== 'handoff') return next(e)
    void handoff($)
    return {}
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      await update($, percent, () => e.context.percent ?? null)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const used = await read($, percent)
    const now = await read($, phase)
    const isBusy = now !== 'idle'

    if (e.props.hasSurvey || (!isBusy && (used === null || used < THRESHOLD))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    // 終端機與桌面版畫綠色膠囊（自訂元件）；其他介面沒有自訂元件，退回一般按鈕
    const button =
      e.surface === 'terminal' || e.surface === 'desktop' ? (
        (() => {
          const { Client } = $.ui.resolve(e)
          return <Client key="handoff" module="./pill.tsx" props={{ label: '交接到新對話' }} />
        })()
      ) : (
        <Button key="handoff" label="交接到新對話" variant="primary" onPress={() => handoff($)} />
      )

    // 盡量短，好跟其他模組（例如用量資訊條）擠在同一行
    const mine = isBusy ? (
      <Text key="handoff-busy" dimColor>{now === 'summarizing' ? '寫交接摘要中…' : '交接中…'}</Text>
    ) : e.props.isWorking ? (
      <Text key="handoff-wait" color="warning">這輪結束後可交接</Text>
    ) : (
      button
    )

    // 底下其他模組畫的東西：併進同一行，而不是各佔一行
    const below = await next(e)
    if (below.type === 'engine') return <Box flexDirection="row">{mine}</Box>

    return (
      <Box flexDirection="row" alignItems="center" columnGap={1} flexWrap="nowrap">
        <Box key="handoff-slot" flexShrink={0}>{mine}</Box>
        <Box key="below" flexGrow={1} flexShrink={1} minWidth={0}>{below}</Box>
      </Box>
    )
  })
}
