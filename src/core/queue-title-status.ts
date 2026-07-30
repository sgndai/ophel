import { ensureQueueEventSounds } from "~core/queue-event-sound"
import { ensureQueueRunLifecycle } from "~core/queue-run-lifecycle"
import { ensureQueueRuntimeUi } from "~core/queue-runtime-ui"
import { useQueueStore } from "~stores/queue-store"

export const MANAGED_STATUS_TOKEN_SOURCE = "(?:⏳|✅)(?:\\d{1,4}\\/\\d{1,4})?"

const MANAGED_TAB_TITLE_ATTR = "data-ophel-managed-tab-title"

type ManagedTitleRenderer = () => string

let latestRenderer: ManagedTitleRenderer | null = null
let latestRenderedTitle: string | null = null
let queueUnsubscribe: (() => void) | null = null
let refreshQueued = false
let isRefreshing = false

ensureQueueRuntimeUi()
ensureQueueRunLifecycle()
ensureQueueEventSounds()

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

export function registerQueueManagedTitle(
  renderer: ManagedTitleRenderer,
  renderedTitle: string,
): void {
  latestRenderer = renderer
  latestRenderedTitle = renderedTitle
  ensureQueueTitleSubscription()
}

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
