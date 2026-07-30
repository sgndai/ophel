import { useQueueStore } from "~stores/queue-store"

const RUNTIME_ROOT_ID = "ophel-queue-runtime-ui"
const RUNTIME_STYLE_ID = "ophel-queue-runtime-ui-style"
const NATIVE_EDITOR_EXCLUDES = [
  ".gh-queue-input",
  ".gh-queue-item-edit-input",
  ".gh-queue-batch-textarea",
  ".gh-dialog-input",
].join(",")

let installed = false
let runtimeRoot: HTMLDivElement | null = null
let domObserver: MutationObserver | null = null
let queueUnsubscribe: (() => void) | null = null
let renderFrameId: number | null = null

function ensureRuntimeStyle(): void {
  if (document.getElementById(RUNTIME_STYLE_ID)) return

  const style = document.createElement("style")
  style.id = RUNTIME_STYLE_ID
  style.textContent = `
#${RUNTIME_ROOT_ID} {
  position: fixed;
  z-index: 10002;
  display: none;
  box-sizing: border-box;
  width: min(360px, calc(100vw - 24px));
  padding: 10px 11px;
  border: 1px solid color-mix(in srgb, var(--gh-text-danger, #dc2626) 32%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--gh-bg-danger, #fef2f2) 92%, var(--gh-bg, #fff));
  color: var(--gh-text, #1f2937);
  box-shadow: 0 8px 26px rgba(15, 23, 42, 0.16);
  font-family: var(--gh-font-family, Inter, system-ui, sans-serif);
}
#${RUNTIME_ROOT_ID}[data-kind="blocked"] {
  border-color: color-mix(in srgb, #f59e0b 38%, transparent);
  background: color-mix(in srgb, #fffbeb 92%, var(--gh-bg, #fff));
}
#${RUNTIME_ROOT_ID} .ophel-queue-runtime-heading {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.3;
}
#${RUNTIME_ROOT_ID} .ophel-queue-runtime-progress {
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 9%, transparent);
  font-variant-numeric: tabular-nums;
}
#${RUNTIME_ROOT_ID} .ophel-queue-runtime-content {
  margin-top: 6px;
  overflow: hidden;
  color: var(--gh-text-secondary, #64748b);
  font-size: 12px;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${RUNTIME_ROOT_ID} .ophel-queue-runtime-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 8px;
}
#${RUNTIME_ROOT_ID} button {
  min-height: 26px;
  padding: 3px 9px;
  border: 1px solid var(--gh-border, #d1d5db);
  border-radius: 7px;
  background: var(--gh-bg, #fff);
  color: var(--gh-text-secondary, #475569);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
}
#${RUNTIME_ROOT_ID} button:hover {
  background: var(--gh-bg-secondary, #f8fafc);
  color: var(--gh-text, #1f2937);
}
#${RUNTIME_ROOT_ID} button[data-action="retry"] {
  border-color: color-mix(in srgb, var(--gh-accent, #4285f4) 38%, transparent);
  color: var(--gh-accent, #4285f4);
  font-weight: 700;
}
#${RUNTIME_ROOT_ID} button[data-action="discard"] {
  color: var(--gh-text-danger, #dc2626);
}
`
  document.head.appendChild(style)
}

function ensureRuntimeRoot(): HTMLDivElement {
  const existing = document.getElementById(RUNTIME_ROOT_ID)
  if (existing instanceof HTMLDivElement) {
    runtimeRoot = existing
    return existing
  }

  const root = document.createElement("div")
  root.id = RUNTIME_ROOT_ID
  root.setAttribute("role", "status")
  root.setAttribute("aria-live", "polite")
  root.addEventListener("click", handleRuntimeAction)
  document.body.appendChild(root)
  runtimeRoot = root
  return root
}

function getVisibleQueueItems() {
  return useQueueStore
    .getState()
    .items.filter((item) => item.status === "pending" || item.status === "sending")
}

function patchQueueOrdinals(): void {
  const visibleItems = getVisibleQueueItems()
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".gh-queue-list .gh-queue-item"))

  rows.forEach((row, index) => {
    const item = visibleItems[index]
    const indexElement = row.querySelector<HTMLElement>(".gh-queue-item-index")
    if (!item || !indexElement) return

    const ordinal = String(item.ordinal)
    if (indexElement.textContent !== ordinal) {
      indexElement.textContent = ordinal
    }
  })
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function positionRuntimeRoot(root: HTMLElement): void {
  const panel = document.querySelector<HTMLElement>(".gh-queue-panel")
  const capsule = document.querySelector<HTMLElement>(".gh-queue-capsule")
  const anchor = panel || capsule
  if (!anchor) {
    root.style.display = "none"
    return
  }

  const rect = anchor.getBoundingClientRect()
  const preferredWidth = panel ? Math.max(260, rect.width - 20) : Math.min(360, rect.width + 150)
  const width = Math.min(preferredWidth, window.innerWidth - 24)
  const left = clamp(rect.right - width, 12, Math.max(12, window.innerWidth - width - 12))

  root.style.width = `${width}px`
  root.style.left = `${left}px`

  if (panel) {
    root.style.top = `${clamp(rect.top + 54, 12, window.innerHeight - 110)}px`
    root.style.bottom = "auto"
  } else {
    root.style.top = "auto"
    root.style.bottom = `${Math.max(12, window.innerHeight - rect.top + 8)}px`
  }
}

function focusNativeEditor(): void {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('textarea, input[type="text"], [contenteditable="true"]'),
  )

  const editor = candidates.find((element) => {
    if (element.matches(NATIVE_EDITOR_EXCLUDES) || element.closest(".gh-root")) return false
    if (!element.isConnected) return false

    const style = window.getComputedStyle(element)
    if (style.display === "none" || style.visibility === "hidden") return false

    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  })

  editor?.scrollIntoView({ block: "center", behavior: "smooth" })
  editor?.focus({ preventScroll: true })
}

function handleRuntimeAction(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null
  if (!target) return

  const action = target.dataset.action
  const itemId = target.dataset.itemId
  const store = useQueueStore.getState()

  if (action === "focus-editor") {
    focusNativeEditor()
    return
  }

  if (!itemId) return

  if (action === "retry") {
    store.retryFailed(itemId)
  } else if (action === "skip") {
    store.skipFailed(itemId)
  } else if (action === "discard") {
    store.discardFailed(itemId)
  }
}

function renderRuntimeUi(): void {
  if (typeof document === "undefined" || !document.body) return

  patchQueueOrdinals()

  const state = useQueueStore.getState()
  const failedItem = state.items.find((item) => item.status === "failed")
  const isBlocked = state.run.phase === "blocked-editor"
  const root = ensureRuntimeRoot()

  if (!failedItem && !isBlocked) {
    root.style.display = "none"
    root.replaceChildren()
    return
  }

  const progressCurrent = failedItem?.ordinal || state.run.current || state.run.completed
  const progress = state.run.total > 0 ? `${progressCurrent}/${state.run.total}` : ""
  const heading = document.createElement("div")
  heading.className = "ophel-queue-runtime-heading"

  const progressElement = document.createElement("span")
  progressElement.className = "ophel-queue-runtime-progress"
  progressElement.textContent = progress
  heading.appendChild(progressElement)

  const title = document.createElement("span")
  title.textContent = failedItem
    ? "发送失败，队列已暂停"
    : state.run.blockedReason === "editor-unknown"
      ? "输入框包含无法确认的内容"
      : "等待输入框清空"
  heading.appendChild(title)

  const actions = document.createElement("div")
  actions.className = "ophel-queue-runtime-actions"

  if (failedItem) {
    const content = document.createElement("div")
    content.className = "ophel-queue-runtime-content"
    content.textContent = failedItem.content

    const retry = document.createElement("button")
    retry.type = "button"
    retry.dataset.action = "retry"
    retry.dataset.itemId = failedItem.id
    retry.textContent = "重试"

    const skip = document.createElement("button")
    skip.type = "button"
    skip.dataset.action = "skip"
    skip.dataset.itemId = failedItem.id
    skip.textContent = "跳过"

    const discard = document.createElement("button")
    discard.type = "button"
    discard.dataset.action = "discard"
    discard.dataset.itemId = failedItem.id
    discard.textContent = "删除"

    actions.append(retry, skip, discard)
    root.replaceChildren(heading, content, actions)
    root.dataset.kind = "failed"
  } else {
    const focus = document.createElement("button")
    focus.type = "button"
    focus.dataset.action = "focus-editor"
    focus.textContent = "定位输入框"
    actions.appendChild(focus)
    root.replaceChildren(heading, actions)
    root.dataset.kind = "blocked"
  }

  root.style.display = "block"
  positionRuntimeRoot(root)
}

function scheduleRender(): void {
  if (renderFrameId !== null || typeof window === "undefined") return

  renderFrameId = window.requestAnimationFrame(() => {
    renderFrameId = null
    renderRuntimeUi()
  })
}

export function ensureQueueRuntimeUi(): void {
  if (installed || typeof window === "undefined" || typeof document === "undefined") return

  const install = () => {
    if (installed || !document.body) return
    installed = true
    ensureRuntimeStyle()
    ensureRuntimeRoot()

    queueUnsubscribe = useQueueStore.subscribe(scheduleRender)
    domObserver = new MutationObserver(scheduleRender)
    domObserver.observe(document.body, { childList: true, subtree: true })
    window.addEventListener("resize", scheduleRender)
    window.addEventListener("scroll", scheduleRender, true)
    scheduleRender()
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true })
  } else {
    install()
  }
}

export function destroyQueueRuntimeUi(): void {
  if (!installed) return

  queueUnsubscribe?.()
  queueUnsubscribe = null
  domObserver?.disconnect()
  domObserver = null
  window.removeEventListener("resize", scheduleRender)
  window.removeEventListener("scroll", scheduleRender, true)

  if (renderFrameId !== null) {
    window.cancelAnimationFrame(renderFrameId)
    renderFrameId = null
  }

  runtimeRoot?.remove()
  runtimeRoot = null
  installed = false
}
