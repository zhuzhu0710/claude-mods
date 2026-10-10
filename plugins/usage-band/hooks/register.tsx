import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Snapshot } from '../types'

// 用量數字：開場與每一輪結束時更新
const snapshot = atom({ plugin: 'usage-band', key: 'snapshot' } as const, null)
// 目前時間：每秒更新一次，只給兩個倒數用
const now = atom({ plugin: 'usage-band', key: 'now' } as const, 0)

const WARN = 80
const BAR = 8

/** 剩餘毫秒 → 「H:MM」（一小時以上）或「MM:SS」 */
export function countdown(ms: number, style: 'hm' | 'ms'): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (style === 'hm') {
    const m = Math.ceil(s / 60)
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
  }
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

// 主對話最後一次送出模型請求後推估的快取到期時間（子代理的請求不算；模組變數：重新載入後下一次請求會補上）
let cacheExpiresAt: number | null = null
// 剩這麼多時間時，快取那一格變黃
const CACHE_WARN_MS = 5 * 60_000

async function tick($: EngineInterface): Promise<void> {
  const n = await $.clock.now()
  await update($, now, () => n)
}

async function measure($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  const five = usage.rateLimits.find(r => r.kind === 'five_hour')
  const week = usage.rateLimits.find(r => r.kind === 'seven_day')
  const resets = five?.resetsAt ? Date.parse(five.resetsAt) : NaN
  const next: Snapshot = {
    context: usage.context.percent ?? null,
    fiveHour: five ? { percent: five.percentUsed, resetsAt: Number.isNaN(resets) ? null : resets } : null,
    weekly: week ? { percent: week.percentUsed } : null,
    cacheExpiresAt,
  }
  await update($, snapshot, () => next)
}


// ── 桌面版：用 SVG 畫，做出深色卡片＋膠囊進度條的樣子 ──
const FONT = 15
const H = 26
const PALETTE = {
  card: '#2b201d',
  border: '#d97757',
  label: '#a39e98',
  value: '#f5f2ee',
  ok: '#4ade80',
  hot: '#f87171',
  track: '#4a4543',
  warn: '#fbbf24',
}

/** 估算等寬字型下的字串寬度（中日韓字約一個字高，其他約 0.62 個字高） */
function textWidth(text: string): number {
  let w = 0
  for (const ch of text) w += /[⺀-￿]/.test(ch) ? FONT : FONT * 0.62
  return Math.ceil(w)
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

type Part =
  | { kind: 'label'; text: string }
  | { kind: 'value'; text: string; color?: string }
  | { kind: 'bar'; percent: number }

const BAR_W = 80
const GAP = 9

/** 一段「標籤＋進度條＋數字」畫成一張小 SVG，回傳 markup 與寬度 */
export function segment(parts: Part[]): { source: string; width: number } {
  let x = 0
  const body: string[] = []
  const y = H / 2
  for (const part of parts) {
    if (x > 0) x += GAP
    if (part.kind === 'bar') {
      const hot = part.percent > WARN
      const fill = Math.min(BAR_W, Math.max(part.percent > 0 ? 6 : 0, (part.percent / 100) * BAR_W))
      body.push(`<rect x="${x}" y="${y - 4}" width="${BAR_W}" height="8" rx="4" fill="${PALETTE.track}"/>`)
      if (fill > 0) body.push(`<rect x="${x}" y="${y - 4}" width="${fill.toFixed(1)}" height="8" rx="4" fill="${hot ? PALETTE.hot : PALETTE.ok}"/>`)
      x += BAR_W
    } else {
      const isValue = part.kind === 'value'
      const color = isValue ? (part.color ?? PALETTE.value) : PALETTE.label
      body.push(
        `<text x="${x}" y="${y}" dominant-baseline="central" fill="${color}"${isValue ? ' font-weight="700"' : ''}>${esc(part.text)}</text>`,
      )
      x += textWidth(part.text)
    }
  }
  const width = Math.ceil(x) + 2
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" ` +
    `font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Noto Sans Mono CJK TC', monospace" font-size="${FONT}">` +
    body.join('') +
    `</svg>`
  return { source, width }
}

/** 終端機格數：中日韓全形字佔兩格，其他一格 */
export function cells(text: string): number {
  let n = 0
  for (const ch of text) n += /[⺀-￿]/.test(ch) ? 2 : 1
  return n
}

/** 依優先順序丟掉放不下的項目，讓資訊條固定一行；priority 越小越先丟，Infinity 永遠保留 */
export function fit<T extends { width: number; priority: number }>(items: T[], room: number, gap: number): T[] {
  const kept = [...items]
  const total = () => kept.reduce((w, it) => w + it.width, 0) + gap * Math.max(0, kept.length - 1)
  while (total() > room) {
    let drop = -1
    for (let i = 0; i < kept.length; i++) {
      if (kept[i]!.priority !== Infinity && (drop < 0 || kept[i]!.priority < kept[drop]!.priority)) drop = i
    }
    if (drop < 0) break
    kept.splice(drop, 1)
  }
  return kept
}

// 其他模組（例如交接按鈕）也畫在輸入框上方時，估計它在終端機佔的格數
const BELOW_CELLS = 22

export const register: Register = (on, options) => {
  const ttlMs = Number(options.cache_ttl_minutes ?? 60) * 60_000
  on('session.start', async ($, e, next) => {
    await tick($)
    await measure($)
    // 每秒走一次倒數；用量數字不在這裡更新
    $.clock.every(1000, () => void tick($))
    return next(e)
  })

  // /clear、/resume、/branch 之後重新取一次
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    cacheExpiresAt = null
    await measure($)
    return next(e)
  })

  // 主對話每送出一次模型請求，快取就從那一刻重新計時
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      cacheExpiresAt = (await $.clock.now()) + ttlMs
      await update($, snapshot, s => (s === null ? s : { ...s, cacheExpiresAt }))
    }
    return yield* next(e)
  })

  // 每一輪結束更新一次
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await tick($)
      await measure($)
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (s === null || e.props.hasSurvey) return next(e)
    const t = await read($, now)
    // 底下其他模組畫的東西：併進同一行，而不是各佔一行
    const below = await next(e)
    const extra = below.type === 'engine' ? null : below

    const hotColor = (p: number) => (p > WARN ? PALETTE.hot : undefined)
    const cacheLeft = s.cacheExpiresAt === null ? 0 : s.cacheExpiresAt - t
    const resetText =
      s.fiveHour?.resetsAt != null && s.fiveHour.resetsAt > t ? `${countdown(s.fiveHour.resetsAt - t, 'hm')} 重置` : null

    if (e.surface === 'desktop') {
      const { Box, Svg } = $.ui.resolve(e)
      const pct = (p: number) => `${Math.round(p)}%`
      const groups: { key: string; alt: string; parts: Part[] }[] = []

      groups.push({
        key: 'ctx',
        alt: `context ${s.context === null ? '—' : pct(s.context)}`,
        parts:
          s.context === null
            ? [{ kind: 'label', text: 'context' }, { kind: 'value', text: '—' }]
            : [
                { kind: 'label', text: 'context' },
                { kind: 'bar', percent: s.context },
                { kind: 'value', text: pct(s.context), color: hotColor(s.context) },
              ],
      })
      if (s.fiveHour) {
        const parts: Part[] = [
          { kind: 'label', text: '5 小時' },
          { kind: 'bar', percent: s.fiveHour.percent },
          { kind: 'value', text: pct(s.fiveHour.percent), color: hotColor(s.fiveHour.percent) },
        ]
        if (resetText) parts.push({ kind: 'label', text: resetText })
        groups.push({ key: '5h', alt: `5 小時 ${pct(s.fiveHour.percent)}${resetText ? `，${resetText}` : ''}`, parts })
      }
      if (s.weekly) {
        groups.push({
          key: '7d',
          alt: `本週 ${pct(s.weekly.percent)}`,
          parts: [
            { kind: 'label', text: '本週' },
            { kind: 'bar', percent: s.weekly.percent },
            { kind: 'value', text: pct(s.weekly.percent), color: hotColor(s.weekly.percent) },
          ],
        })
      }

      const svg = (key: string, alt: string, parts: Part[]) => {
        const seg = segment(parts)
        return <Svg key={key} source={seg.source} alt={alt} width={seg.width} height={H} />
      }

      const right =
        s.cacheExpiresAt === null
          ? null
          : cacheLeft > 0
            ? svg('cache', `快取 ${countdown(cacheLeft, 'ms')}`, [
                { kind: 'label', text: '快取' },
                { kind: 'value', text: countdown(cacheLeft, 'ms'), color: cacheLeft <= CACHE_WARN_MS ? PALETTE.warn : undefined },
              ])
            : svg('cache', '快取 已過期，下一句會重新計算', [
                { kind: 'label', text: '快取' },
                { kind: 'value', text: '已過期，下一句會重新計算', color: PALETTE.hot },
              ])

      return (
        <Box
          flexDirection="row"
          justifyContent="space-between"
          alignItems="center"
          borderStyle="round"
          borderColor={PALETTE.border}
          backgroundColor={PALETTE.card}
          paddingX={1}
        >
          <Box flexDirection="row" columnGap={3} flexWrap="nowrap" alignItems="center" flexShrink={1} minWidth={0} overflow="hidden">
            {extra ? <Box key="below" flexShrink={0}>{extra}</Box> : null}
            {groups.map(g => svg(g.key, g.alt, g.parts))}
          </Box>
          {right ? <Box key="right" flexShrink={0}>{right}</Box> : null}
        </Box>
      )
    }

    // ── 終端機：文字版 ──
    const { Box, Text } = $.ui.resolve(e)

    const bar = (key: string, percent: number) => {
      const hot = percent > WARN
      const filled = Math.min(BAR, Math.max(0, Math.round((percent / 100) * BAR)))
      return (
        <Box key={key} flexDirection="row" columnGap={1}>
          <Text>
            <Text color={hot ? 'error' : 'success'}>{'━'.repeat(filled)}</Text>
            <Text color="inactive">{'━'.repeat(BAR - filled)}</Text>
          </Text>
          <Text bold color={hot ? 'error' : undefined}>{`${Math.round(percent)}%`}</Text>
        </Box>
      )
    }

    const metricCells = (label: string, percent: number | null) =>
      cells(label) + 1 + (percent === null ? 1 : BAR + 1 + `${Math.round(percent)}%`.length)

    const metric = (key: string, label: string, percent: number | null) => (
      <Box key={key} flexDirection="row" columnGap={1}>
        <Text dimColor>{label}</Text>
        {percent === null ? <Text dimColor>—</Text> : bar(`${key}-bar`, percent)}
      </Box>
    )

    // 每一項附上寬度與優先順序；放不下時先丟優先順序低的
    type Item = { node: ReturnType<typeof metric>; width: number; priority: number }
    const items: Item[] = []
    if (extra) items.push({ node: <Box key="below">{extra}</Box>, width: BELOW_CELLS, priority: Infinity })
    items.push({ node: metric('ctx', 'context', s.context), width: metricCells('context', s.context), priority: Infinity })
    if (s.fiveHour) {
      items.push({ node: metric('5h', '5 小時', s.fiveHour.percent), width: metricCells('5 小時', s.fiveHour.percent), priority: 3 })
      if (resetText) items.push({ node: <Text key="reset" dimColor>{resetText}</Text>, width: cells(resetText), priority: 1 })
    }
    if (s.weekly) items.push({ node: metric('7d', '本週', s.weekly.percent), width: metricCells('本週', s.weekly.percent), priority: 2 })

    const cacheText = s.cacheExpiresAt === null ? null : cacheLeft > 0 ? countdown(cacheLeft, 'ms') : '已過期，下一句會重新計算'
    // 外框兩格、左右內距兩格、左右兩群之間至少留一格
    const room = e.props.bodyColumns - 4 - (cacheText === null ? 0 : cells('快取') + 1 + cells(cacheText) + 1)
    const left = fit(items, room, 2).map(it => it.node)

    const right =
      s.cacheExpiresAt === null ? null : (
        <Box key="cache" flexDirection="row" columnGap={1}>
          <Text dimColor>快取</Text>
          {cacheLeft > 0 ? (
            <Text bold color={cacheLeft <= CACHE_WARN_MS ? 'warning' : undefined}>{countdown(cacheLeft, 'ms')}</Text>
          ) : (
            <Text bold color="error">已過期，下一句會重新計算</Text>
          )}
        </Box>
      )

    return (
      <Box flexDirection="row" justifyContent="space-between" borderStyle="round" borderColor="claude" paddingX={1}>
        <Box flexDirection="row" columnGap={2} flexWrap="nowrap" flexShrink={1} minWidth={0} overflow="hidden">
          {left}
        </Box>
        {right}
      </Box>
    )
  })
}
