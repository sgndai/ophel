import { useQueueStore } from "~stores/queue-store"
import { EVENT_MONITOR_COMPLETE } from "~utils/messaging"

let installed = false
let completionQueued = false

function hasCompletableActiveStep(): boolean {
  const state = useQueueStore.getState()
  return (
    state.run.runId !== null &&
    state.run.activeItemId !== null &&
    (state.run.phase === "generating" || state.run.phase === "submitting") &&
    !state.isPaused
  )
}

function scheduleActiveStepCompletion(): void {
  if (completionQueued || !hasCompletableActiveStep()) return

  completionQueued = true
  queueMicrotask(() => {
    completionQueued = false
    if (!hasCompletableActiveStep()) return
    useQueueStore.getState().markCurrentComplete()
  })
}

function handleMonitorMessage(event: MessageEvent): void {
  if (event.origin !== window.location.origin) return
  if (event.data?.type !== EVENT_MONITOR_COMPLETE) return
  scheduleActiveStepCompletion()
}

/**
 * 安装队列运行进度监听。
 * 网络监控完成事件是主信号；标题状态观察作为站点兼容后备。
 */
export function ensureQueueRunLifecycle(): void {
  if (installed || typeof window === "undefined") return
  installed = true
  window.addEventListener("message", handleMonitorMessage)
}

/**
 * 当 TabManager 已将当前会话判断为完成时，推进当前队列步骤。
 * 这里只接受完成图标，暂停或无活动步骤时不会写入。
 */
export function observeQueueManagedStatus(statusPrefix: string): void {
  if (!statusPrefix.includes("✅")) return
  scheduleActiveStepCompletion()
}
