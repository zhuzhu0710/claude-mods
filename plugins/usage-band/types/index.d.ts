export type Snapshot = {
  /** context 使用百分比；第一次回應前沒有數字 */
  context: number | null
  /** 五小時額度；resetsAt 為毫秒時間戳 */
  fiveHour: { percent: number; resetsAt: number | null } | null
  /** 本週額度 */
  weekly: { percent: number } | null
  /** 推估的提示快取到期時間（毫秒時間戳）；沒有快取則為 null */
  cacheExpiresAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { snapshot: Snapshot | null; now: number }
  }
}
