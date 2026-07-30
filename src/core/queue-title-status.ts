import { useQueueStore } from "~stores/queue-store"

export const MANAGED_STATUS_TOKEN_SOURCE = "(?:⏳|✅)(?:\\d{1,4}\\/\\d{1,4})?"

function getStatusIcon(statusPrefix: string): "⏳" | "✅" | "" {
  if (statusPrefix.includes("⏳")) return "⏳"
  if (statusPrefix.includes("✅")) return "✅"
  return ""
}

/**
 * 将标签页状态压缩成无空格形式，并在多步队列中附加 current/total。
 * 普通单次生成仍保持 ⏳标题 / ✅标题。
 */
export function formatQueueAwareStatusPrefix(statusPrefix: string): string {
  const icon = getStatusIcon(statusPrefix)
  if (!icon) return ""

  const queue = useQueueStore.getState()
  const { run } = queue

  if (!run.runId || run.total <= 1) return icon

  const current = Math.min(Math.max(run.current, 0), run.total)
  const hasRemainingWork = queue.items.some(
    (item) => item.status === "pending" || item.status === "sending" || item.status === "failed",
  )
  const isQueueComplete = current >= run.total && !hasRemainingWork && icon === "✅"
  const effectiveIcon = isQueueComplete ? "✅" : "⏳"

  return `${effectiveIcon}${current}/${run.total}`
}
