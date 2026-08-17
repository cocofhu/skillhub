/** Fail-loud shell recovery UI state machine (fail → running → success/error). */

export const FAIL_PAGE_COPY = {
  title: 'Failed to load plugins',
  button: '快速修复 · 卸载全部第三方',
  warningTitle: '粗暴模式 · 会卸载所有第三方插件',
  warningBody:
    '不逐个甄别肇事项：一次性移除 profile 内全部第三方包（含 anime-find、skillhub 等），再重启 dsh web。基线内置插件保留。',
  hint: '目标：立刻拉回可用 UI。副作用：第三方能力全部清掉，需事后按需重装。',
  running: '正在执行粗暴快速修复…',
  successTitle: '服务已恢复（安全模式）',
  successBody: '全部第三方插件已卸载；仅基线能力在线，Web UI 可正常进入。',
  restartHint: '请重启 dsh web 并强制刷新。第三方清零后才会进入可用 UI。',
} as const

export type FailPagePhase = 'fail' | 'running' | 'success' | 'error'
export type LogClass = 'ok' | 'bad' | 'warn'

export interface FailPageLog {
  text: string
  cls?: LogClass
}

export interface FailPageState {
  phase: FailPagePhase
  logs: FailPageLog[]
  progress: number
  error?: string
  removed: string[]
  kept: string[]
}

export type FailPageEvent =
  | { type: 'start' }
  | { type: 'log'; text: string; cls?: LogClass; progress?: number }
  | { type: 'success'; removed: string[]; kept: string[] }
  | { type: 'error'; message: string }
  | { type: 'retry' }

export function initialFailPageState(): FailPageState {
  return { phase: 'fail', logs: [], progress: 0, removed: [], kept: [] }
}

export function buttonEnabled(state: FailPageState): boolean {
  return state.phase === 'fail' || state.phase === 'error'
}

export function reduceFailPage(state: FailPageState, event: FailPageEvent): FailPageState {
  switch (event.type) {
    case 'start':
      if (!buttonEnabled(state)) return state
      return { phase: 'running', logs: [], progress: 0, removed: [], kept: [] }
    case 'log':
      if (state.phase !== 'running') return state
      return {
        ...state,
        logs: [...state.logs, { text: event.text, cls: event.cls }],
        progress: event.progress == null ? state.progress : clamp(event.progress, 0, 100),
      }
    case 'success':
      if (state.phase !== 'running') return state
      return {
        phase: 'success',
        logs: state.logs,
        progress: 100,
        removed: [...event.removed],
        kept: [...event.kept],
      }
    case 'error':
      if (state.phase !== 'running') return state
      return {
        ...state,
        phase: 'error',
        error: event.message,
      }
    case 'retry':
      if (state.phase !== 'error') return state
      return initialFailPageState()
    default:
      return state
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}
