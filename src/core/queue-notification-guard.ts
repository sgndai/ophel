import { useQueueStore } from "~stores/queue-store"

const PATCH_MARKER = Symbol.for("ophel.queue-notification-guard-patched")

type RuntimeMethod = (this: unknown, ...args: unknown[]) => unknown
type MutablePrototype = Record<string | symbol, unknown>

let installed = false

function shouldSuppressIntermediateQueueSound(): boolean {
  const state = useQueueStore.getState()
  if (!state.run.runId || state.run.total <= 1) return false
  if (state.run.phase === "completed") return false

  return (
    state.run.completed < state.run.total ||
    state.items.some(
      (item) => item.status === "pending" || item.status === "sending" || item.status === "failed",
    )
  )
}

function patchTabManagerNotificationSound(): void {
  void import("~core/tab-manager")
    .then(({ TabManager }) => {
      const prototype = TabManager.prototype as unknown as MutablePrototype
      if (prototype[PATCH_MARKER]) return

      const candidate = prototype.playNotificationSound
      if (typeof candidate !== "function") {
        console.warn("[QueueNotificationGuard] TabManager sound method was not found")
        return
      }

      const originalPlayNotificationSound = candidate as RuntimeMethod
      prototype.playNotificationSound = function (this: unknown, ...args: unknown[]): unknown {
        if (shouldSuppressIntermediateQueueSound()) return undefined
        return originalPlayNotificationSound.apply(this, args)
      }
      prototype[PATCH_MARKER] = true
    })
    .catch((error) => {
      console.warn("[QueueNotificationGuard] Failed to patch TabManager sound:", error)
    })
}

/**
 * 多步队列执行期间屏蔽 TabManager 的单轮完成音。
 * 最终队列完成音由 queue-event-sound 在 run.phase 进入 completed 时统一播放。
 */
export function ensureQueueNotificationGuard(): void {
  if (installed || typeof window === "undefined") return
  installed = true
  patchTabManagerNotificationSound()
}
