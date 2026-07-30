import { useQueueStore } from "~stores/queue-store"

const PATCH_MARKER = Symbol.for("ophel.queue-notification-guard-patched")

type RuntimeMethod = (this: unknown, ...args: unknown[]) => unknown
type MutablePrototype = Record<string | symbol, unknown>

let installed = false

function shouldSuppressIntermediateQueueSound(): boolean {
  const state = useQueueStore.getState()
  if (!state.run.runId || state.run.total <= 1) return false
  if (state.run.phase