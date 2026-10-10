/** 毫秒時間戳記；尚未有值時為 null */
export type Stamp = number | null

declare module 'claude-code' {
  interface PluginState {
    'cache-timer': {
      /** 主對話最後一次送出模型請求的時間 */
      lastSentAt: Stamp
      /** 已經為哪一次送出跳過「剩五分鐘」提醒 */
      warnedFor: Stamp
    }
  }
}
