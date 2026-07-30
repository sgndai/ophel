import { useQueueStore } from "~stores/queue-store"

const PATCH_MARKER = Symbol.for("ophel.queue-run-lifecycle-patched")

interface QueueDispatcherRuntime {
  postSubmitWaitPromise: Promise<void> | null
  isRunning: () => boolean
}

type RuntimeMethod = (this: QueueDispatcherRuntime, ...args: unknown[]) => unknown

type MutablePrototype = Record<string | symbol, unknown>

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

function patchQueueDispatcherLifecycle(): void {
  void import("~core/queue-dispatcher")
    .then(({ QueueDispatcher }) => {
      const prototype = QueueDispatcher.prototype as unknown as MutablePrototype
      if (prototype[PATCH_MARKER]) return

      const startWaitCandidate = prototype.startPostSubmitWait
      if (typeof startWaitCandidate !== "function") {
        console.warn("[QueueRunLifecycle] QueueDispatcher wait method was not found")
        return
      }

      const originalStartPostSubmitWait = startWaitCandidate as RuntimeMethod
      prototype.startPostSubmitWait = function (
        this: QueueDispatcherRuntime,
        ...args: unknown[]
      ): unknown {
        const previousWait = this.postSubmitWaitPromise
        const result = originalStartPostSubmitWait.apply(this, args)
        const currentWait = this.postSubmitWaitPromise

        if (currentWait && currentWait !== previousWait) {
          void currentWait.then(() => {
            // 安全暂停、对话切换和 dispatcher 销毁都不能冒充正常完成。
            if (!this.isRunning()) return
            scheduleActiveStepCompletion()
          })
        }

        return result
      }

      const completeItemCandidate = prototype.completeItem
      if (typeof completeItemCandidate === "function") {
        const originalCompleteItem = completeItemCandidate as RuntimeMethod
        prototype.completeItem = function (
          this: QueueDispatcherRuntime,
          itemId: unknown,
          ...args: unknown[]
        ): unknown {
          const item =
            typeof itemId === "string"
              ? useQueueStore.getState().items.find((candidate) => candidate.id === itemId)
              : undefined
          const result = originalCompleteItem.apply(this, [itemId, ...args])

          // 只插入不发送的任务没有回复等待阶段，应在插入成功后立即完成。
          if (item?.metadata?.runMode === "insert" && this.isRunning()) {
            scheduleActiveStepCompletion()
          }

          return result
        }
      }

      prototype[PATCH_MARKER] = true
    })
    .catch((error) => {
      console.warn("[QueueRunLifecycle] Failed to patch QueueDispatcher lifecycle:", error)
    })
}

/**
 * 将队列进度绑定到 QueueDispatcher 自己的稳定回复等待结果。
 * 不直接使用原始网络 COMPLETE，因为 ChatGPT 思考模式的该事件可能只是 handoff 完成。
 */
export function ensureQueueRunLifecycle(): void {
  if (installed || typeof window === "undefined") return
  installed = true
  patchQueueDispatcherLifecycle()
}
