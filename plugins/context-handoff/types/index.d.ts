export type Phase = 'idle' | 'summarizing' | 'clearing'

declare module 'claude-code' {
  interface PluginState {
    'context-handoff': { percent: number | null; phase: Phase }
  }
}
