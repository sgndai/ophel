import { useQueueStore } from "~stores/queue-store"

export const MANAGED_STATUS_TOKEN_SOURCE = "(?:⏳|✅)(?:\\d{1,4}\\/\\d{1,4})?"

const MANAGED_TAB_TITLE_ATTR = "data-ophel-managed-tab-title"

type ManagedTitleRenderer = () => string

let latestRenderer: ManagedTitleRenderer | null = null
let latestRenderedTitle: string | null = null
let queueUnsubscribe: (() => void) | null = null
let refreshQueued = false
let isRefreshing = false

function getStatusIcon(statusPrefix: string): "⏳" | "✅" | "" {
  if (statusPrefix.includes("⏳")) return "⏳"
  if (statusPrefix.includes("✅")) return "✅"
  return ""
}

function scheduleManagedTitleRefresh(): void {
  if (refreshQueued || isRefreshing || typeof document === "undefined") return

  refreshQueued = true
  queueMicrotask(() => {
    refreshQueued = false
    refreshManagedTitle()
  })
}

function refreshManagedTitle(): void {
  if (!latestRenderer || !latestRenderedTitle || isRefreshing) return
  if (typeof document === "undefined") return

  const rememberedTitle = document.documentElement?.getAttribute(MANAGED_TAB_TITLE_ATTR)
  if (rememberedTitle !== latestRenderedTitle || document.title !== latestRenderedTitle) {
    return
  }

  isRefreshing = true
  try {
    const nextTitle = latestRenderer()
    if (!nextTitle || nextTitle === latestRenderedTitle) return

    latestRenderedTitle = nextTitle
    document.documentElement?.setAttribute(MANAGED_TAB_TITLE_ATTR, nextTitle)
    document.title = nextTitle
  } finally {
    queueMicrotask(() => {
      isRefreshing = false
    })
  }
}

function ensureQueueTitleSubscription(): void {
  if (queueUnsubscribe || typeof window === "undefined") return

  queueUnsubscribe = useQueueStore.subscribe(() => {
    scheduleManagedTitleRefresh()
  })
}

/**
 * 保存最近一次由 OPhEL 生成的完整标题渲染函数。
 * 队列状态变化时，只有当前标题仍与受管标题完全一致才会重新渲染，
 * 因而不会覆盖隐私标题、站点原生标题或用户关闭自动重命名后的标题。
 */
export function registerQueueManagedTitle(
  renderer: ManagedTitleRenderer,
  renderedTitle: string,
): void {
  latestRenderer = renderer
  latestRenderedTitle = renderedTitle
  ensureQueueTitleSubscription()
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
