import { ensureQueueEventSounds } from "~core/queue-event-sound"
import { ensureQueueNotificationGuard } from "~core/queue-notification-guard"
import { ensureQueueRunLifecycle } from "~core/queue-run-lifecycle"
import { ensureQueueRuntimeUi } from "~core/queue-runtime-ui"
import { useQueueStore } from "~stores/queue-store"
import { EVENT_PAGE_URL_CHANGE } from "~utils/messaging"

export const MANAGED_STATUS_TOKEN_SOURCE = "(?:⏳|✅|📝)(?:\\d{1,4}\\/\\d{1,4})?"

const MANAGED_TAB_TITLE_ATTR = "data-ophel-managed-tab-title"
const QUEUE_PROGRESS_PREFIX_PATTERN = /^(?:⏳|✅|📝)\d{1,4}\/\d{1,4}\s*/u

type ManagedTitleRenderer = () => string

let latestRenderer: ManagedTitleRenderer | null = null
let latestRenderedTitle: string | null = null
let queueUnsubscribe: (() => void) | null = null
let titleObserver: MutationObserver | null = null
let refreshQueued = false
let isRefreshing = false
let installed = false

ensureQueueRuntimeUi()
ensureQueueRunLifecycle()
ensureQueueEventSounds()
ensureQueueNotificationGuard()
ensureQueueTitleRuntime()

function getStatusIcon(statusPrefix: string): "⏳" | "✅" | "📝" | "" {
  if (statusPrefix.includes("⏳")) return "⏳"
  if (statusPrefix.includes("📝")) return "📝"
  if (statusPrefix.includes("✅")) return "✅"
  return ""
}

function getCurrentConversationKey(): string | null {
  if (typeof window === "undefined") return null
  return `${window.location.origin}${window.location.pathname}`
}

function getQueueRunStatusToken(): string | null {
  const state = useQueueStore.getState()
  const { run } = state

  if (!run.runId || run.total <= 1) return null
  if (run.conversationKey && run.conversationKey !== getCurrentConversationKey()) return null

  const fallbackCurrent = run.completed < run.total ? run.completed + 1 : run.total
  const current = Math.min(Math.max(run.current || fallbackCurrent, 1), run.total)

  if (run.phase === "completed") return `✅${run.total}/${run.total}`
  if (run.phase === "blocked-editor") return `📝${current}/${run.total}`
  return `⏳${current}/${run.total}`
}

function stripQueueProgressPrefix(title: string): string {
  return title.replace(QUEUE_PROGRESS_PREFIX_PATTERN, "").trimStart()
}

function syncQueueProgressWithDocumentTitle(): boolean {
  if (typeof document === "undefined") return false

  const queueToken = getQueueRunStatusToken()
  const currentTitle = document.title
  const baseTitle = stripQueueProgressPrefix(currentTitle)

  if (!queueToken) {
    if (baseTitle === currentTitle) return false

    isRefreshing = true
    try {
      document.title = baseTitle
      document.documentElement?.setAttribute(MANAGED_TAB_TITLE_ATTR, baseTitle)
      latestRenderedTitle = baseTitle
    } finally {
      queueMicrotask(() => {
        isRefreshing = false
      })
    }
    return true
  }

  const nextTitle = `${queueToken}${baseTitle}`
  if (nextTitle === currentTitle) return true

  isRefreshing = true
  try {
    document.title = nextTitle
    document.documentElement?.setAttribute(MANAGED_TAB_TITLE_ATTR, nextTitle)
    latestRenderedTitle = nextTitle
  } finally {
    queueMicrotask(() => {
      isRefreshing = false
    })
  }
  return true
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
  if (isRefreshing || typeof document === "undefined") return

  if (syncQueueProgressWithDocumentTitle()) return
  if (!latestRenderer || !latestRenderedTitle) return

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

function handlePageMessage(event: MessageEvent): void {
  if (event.origin !== window.location.origin) return
  if (event.data?.type !== EVENT_PAGE_URL_CHANGE) return
  scheduleManagedTitleRefresh()
}

function installTitleObserver(): void {
  if (titleObserver || typeof MutationObserver === "undefined" || !document.head) return

  titleObserver = new MutationObserver(() => {
    if (!isRefreshing) scheduleManagedTitleRefresh()
  })
  titleObserver.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  })
}

function ensureQueueTitleRuntime(): void {
  if (installed || typeof window === "undefined" || typeof document === "undefined") return
  installed = true

  queueUnsubscribe = useQueueStore.subscribe(scheduleManagedTitleRefresh)
  window.addEventListener("message", handlePageMessage)
  window.addEventListener("popstate", scheduleManagedTitleRefresh)
  window.addEventListener("hashchange", scheduleManagedTitleRefresh)
  window.addEventListener("focus", scheduleManagedTitleRefresh)
  document.addEventListener("visibilitychange", scheduleManagedTitleRefresh)

  const install = () => {
    installTitleObserver()
    scheduleManagedTitleRefresh()
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true })
  } else {
    install()
  }
}

export function registerQueueManagedTitle(
  renderer: ManagedTitleRenderer,
  renderedTitle: string,
): void {
  latestRenderer = renderer
  latestRenderedTitle = renderedTitle
  scheduleManagedTitleRefresh()
}

export function formatQueueAwareStatusPrefix(statusPrefix: string): string {
  const queueToken = getQueueRunStatusToken()
  if (queueToken) return queueToken

  return getStatusIcon(statusPrefix)
}
