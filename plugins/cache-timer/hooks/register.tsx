import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { TTL_MS, WARN_MS } from './logic'

// 倒數本身畫在 usage-band 那一行的「快取」格；這裡只負責剩五分鐘時跳提醒
const lastSentAt = atom({ plugin: 'cache-timer', key: 'lastSentAt' } as const, null)
const warnedFor = atom({ plugin: 'cache-timer', key: 'warnedFor' } as const, null)

export const register: Register = on => {
  // 主對話每送出一次模型請求就重新計時；子代理（subagent）的請求帶有 agentId，不算
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, lastSentAt, () => now)
    }
    return yield* next(e)
  })

  // 每秒檢查一次：剩五分鐘時跳一次提醒
  on('session.start', async ($, e, next) => {
    $.clock.every(1000, async () => {
      const sentAt = await read($, lastSentAt)
      if (sentAt === null) {
        return
      }
      const left = sentAt + TTL_MS - (await $.clock.now())
      if (left > 0 && left <= WARN_MS && (await read($, warnedFor)) !== sentAt) {
        await update($, warnedFor, () => sentAt)
        $.ui.toast('提示快取剩不到 5 分鐘就會過期，要繼續就趁現在送出下一句', { timeoutMs: 10000 })
      }
    })
    return next(e)
  })
}
