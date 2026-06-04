import type { SiteAdapter } from "~adapters/base"

export type MessageNavigatorRole = "user" | "assistant"

export interface MessageNavigatorItem {
  id: string
  role: MessageNavigatorRole
  textPreview: string
  element: HTMLElement
  order: number
}

const STYLE_ID = "ophel-message-navigator-style"
const ROOT_ID = "ophel-message-navigator"
const NODE_CLASS = "ophel-message-nav-node"
const ACTIVE_CLASS = "is-active"
const REFRESH_DEBOUNCE_MS = 180
const PREVIEW_MAX_LENGTH = 120

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false

  const editable = target.closest(
    [
      "input",
      "textarea",
      "select",
      "iframe",
      "[contenteditable='true']",
      "[contenteditable='']",
      "[role='textbox']",
      ".gh-main-panel",
      ".gh-queue-panel",
      ".gh-queue-capsule",
      ".gh-interactive",
    ].join(","),
  )

  return Boolean(editable)
}

function normalizeText(value: string | null | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim()
}

function truncateText(value: string, maxLength = PREVIEW_MAX_LENGTH): string {
  const normalized = normalizeText(value)
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength)}…`
}

function isVisibleElement(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false
  if (!element.isConnected) return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

export class MessageNavigatorManager {
  private adapter: SiteAdapter
  private root: HTMLDivElement | null = null
  private items: MessageNavigatorItem[] = []
  private activeIndex = -1
  private observer: MutationObserver | null = null
  private refreshTimer: number | null = null
  private scrollRaf: number | null = null
  private started = false

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.started) return
    if (event.defaultPrevented) return
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (isEditableTarget(event.target)) return

    const direction = event.key === "ArrowDown" ? 1 : -1
    const moved = this.moveActive(direction)
    if (!moved) return

    event.preventDefault()
    event.stopPropagation()
  }

  private handleScroll = (): void => {
    if (this.scrollRaf !== null) return
    this.scrollRaf = window.requestAnimationFrame(() => {
      this.scrollRaf = null
      this.syncActiveFromViewport()
    })
  }

  constructor(adapter: SiteAdapter) {
    this.adapter = adapter
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.injectStyles()
    this.mountRoot()
    this.refresh()
    this.observe()
    document.addEventListener("keydown", this.handleKeyDown, true)
    window.addEventListener("scroll", this.handleScroll, { passive: true, capture: true })
    window.addEventListener("resize", this.handleScroll, { passive: true })
    window.addEventListener("gh-url-change", this.handleUrlChange)
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.observer?.disconnect()
    this.observer = null
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    if (this.scrollRaf !== null) {
      window.cancelAnimationFrame(this.scrollRaf)
      this.scrollRaf = null
    }
    document.removeEventListener("keydown", this.handleKeyDown, true)
    window.removeEventListener("scroll", this.handleScroll, true)
    window.removeEventListener("resize", this.handleScroll)
    window.removeEventListener("gh-url-change", this.handleUrlChange)
    this.root?.remove()
    this.root = null
    this.items = []
    this.activeIndex = -1
  }

  private handleUrlChange = (): void => {
    this.items = []
    this.activeIndex = -1
    this.root?.replaceChildren()
    this.scheduleRefresh(300)
  }

  private observe(): void {
    const target = this.adapter.getObserveTarget?.() || document.body
    if (!target) return

    this.observer?.disconnect()
    this.observer = new MutationObserver(() => this.scheduleRefresh())
    this.observer.observe(target, {
      childList: true,
      subtree: true,
    })
  }

  private scheduleRefresh(delay = REFRESH_DEBOUNCE_MS): void {
    if (!this.started) return
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer)
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null
      this.refresh()
    }, delay)
  }

  private refresh(): void {
    if (!this.started) return
    this.mountRoot()
    const nextItems = this.collectItems()
    const signature = nextItems.map((item) => item.id).join("|")
    const currentSignature = this.items.map((item) => item.id).join("|")

    this.items = nextItems
    if (signature !== currentSignature) {
      this.render()
    }
    this.syncActiveFromViewport()
  }

  private collectItems(): MessageNavigatorItem[] {
    const siteId = this.adapter.getSiteId()
    if (siteId === "chatgpt") return this.collectChatGPTItems()
    if (siteId === "gemini" || siteId === "gemini-enterprise") return this.collectGeminiItems()
    if (siteId === "deepseek") return this.collectDeepSeekItems()
    return this.collectGenericItems()
  }

  private collectChatGPTItems(): MessageNavigatorItem[] {
    const container = document.querySelector(this.adapter.getResponseContainerSelector()) || document
    const nodes = Array.from(
      container.querySelectorAll("[data-message-author-role='user'], [data-message-author-role='assistant']"),
    ).filter(isVisibleElement)

    return nodes.map((element, order) => {
      const role = element.getAttribute("data-message-author-role") === "assistant" ? "assistant" : "user"
      const messageId = element.getAttribute("data-message-id")
      const turnId = element.closest("[data-turn-id]")?.getAttribute("data-turn-id")
      return {
        id: `chatgpt:${role}:${messageId || turnId || order}`,
        role,
        textPreview: truncateText(
          role === "user"
            ? this.adapter.extractUserQueryText(element)
            : this.adapter.extractAssistantResponseText(element),
        ),
        element,
        order,
      }
    })
  }

  private collectGeminiItems(): MessageNavigatorItem[] {
    const container = document.querySelector(this.adapter.getResponseContainerSelector()) || document
    const nodes = Array.from(container.querySelectorAll("user-query, model-response")).filter(
      isVisibleElement,
    )

    return nodes.map((element, order) => {
      const role = element.tagName.toLowerCase() === "model-response" ? "assistant" : "user"
      const rawId = element.id || element.getAttribute("data-message-id") || order
      return {
        id: `gemini:${role}:${rawId}`,
        role,
        textPreview: truncateText(
          role === "user"
            ? this.adapter.extractUserQueryText(element)
            : this.adapter.extractAssistantResponseText(element),
        ),
        element,
        order,
      }
    })
  }

  private collectDeepSeekItems(): MessageNavigatorItem[] {
    const container = this.adapter.getScrollContainer() || document
    const nodes = Array.from(container.querySelectorAll(".ds-message")).filter(isVisibleElement)

    return nodes.map((element, order) => {
      const role = element.querySelector(".ds-markdown") ? "assistant" : "user"
      return {
        id: `deepseek:${role}:${order}:${truncateText(element.textContent || "", 32)}`,
        role,
        textPreview: truncateText(
          role === "user"
            ? this.adapter.extractUserQueryText(element)
            : this.adapter.extractAssistantResponseText(element),
        ),
        element,
        order,
      }
    })
  }

  private collectGenericItems(): MessageNavigatorItem[] {
    const config = this.adapter.getExportConfig?.()
    if (!config) return []
    const container = config.turnSelector
      ? document.querySelector(config.turnSelector)?.parentElement || document
      : document
    const nodes = Array.from(
      container.querySelectorAll(`${config.userQuerySelector}, ${config.assistantResponseSelector}`),
    ).filter(isVisibleElement)

    return nodes.map((element, order) => {
      const role = element.matches(config.assistantResponseSelector) ? "assistant" : "user"
      return {
        id: `generic:${role}:${order}:${truncateText(element.textContent || "", 32)}`,
        role,
        textPreview: truncateText(element.textContent || ""),
        element,
        order,
      }
    })
  }

  private mountRoot(): void {
    if (this.root?.isConnected) return
    let root = document.getElementById(ROOT_ID) as HTMLDivElement | null
    if (!root) {
      root = document.createElement("div")
      root.id = ROOT_ID
      root.setAttribute("aria-label", "Message navigator")
      document.body.appendChild(root)
    }
    this.root = root
  }

  private render(): void {
    if (!this.root) return
    const fragment = document.createDocumentFragment()

    for (const item of this.items) {
      const button = document.createElement("button")
      button.type = "button"
      button.className = `${NODE_CLASS} role-${item.role}`
      button.dataset.id = item.id
      button.title = `${item.role === "user" ? "User" : "AI"}: ${item.textPreview}`
      button.textContent = item.role === "user" ? "U" : "A"
      button.addEventListener("click", () => this.scrollToItem(item))
      fragment.appendChild(button)
    }

    this.root.replaceChildren(fragment)
  }

  private syncActiveFromViewport(): void {
    if (this.items.length === 0) {
      this.setActiveIndex(-1)
      return
    }

    const viewportPivot = Math.max(80, window.innerHeight * 0.18)
    let bestIndex = 0
    let bestDistance = Number.POSITIVE_INFINITY

    this.items.forEach((item, index) => {
      if (!item.element.isConnected) return
      const rect = item.element.getBoundingClientRect()
      const distance = Math.abs(rect.top - viewportPivot)
      if (rect.top <= window.innerHeight && rect.bottom >= 0 && distance < bestDistance) {
        bestDistance = distance
        bestIndex = index
      }
    })

    this.setActiveIndex(bestIndex)
  }

  private setActiveIndex(index: number): void {
    if (this.activeIndex === index) return
    this.activeIndex = index
    if (!this.root) return

    Array.from(this.root.querySelectorAll(`.${NODE_CLASS}`)).forEach((node, nodeIndex) => {
      node.classList.toggle(ACTIVE_CLASS, nodeIndex === index)
    })
  }

  private moveActive(direction: 1 | -1): boolean {
    if (this.items.length === 0) {
      this.refresh()
    }
    if (this.items.length === 0) return false

    const current = this.activeIndex >= 0 ? this.activeIndex : 0
    const next = Math.min(this.items.length - 1, Math.max(0, current + direction))
    if (next === this.activeIndex) return false
    this.scrollToItem(this.items[next])
    this.setActiveIndex(next)
    return true
  }

  private scrollToItem(item: MessageNavigatorItem): void {
    if (!item.element.isConnected) {
      this.scheduleRefresh(0)
      return
    }

    item.element.scrollIntoView({
      block: "start",
      behavior: "instant",
      __bypassLock: true,
    } as ScrollIntoViewOptions)
  }

  private injectStyles(): void {
    if (document.getElementById(STYLE_ID)) return
    const style = document.createElement("style")
    style.id = STYLE_ID
    style.textContent = `
#${ROOT_ID} {
  position: fixed;
  right: 6px;
  top: 22%;
  max-height: 56vh;
  width: 22px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  z-index: 2147483000;
  pointer-events: auto;
}
#${ROOT_ID}:empty { display: none; }
#${ROOT_ID} .${NODE_CLASS} {
  width: 18px;
  height: 18px;
  border-radius: 999px;
  border: 1px solid rgba(120, 120, 120, 0.32);
  background: rgba(32, 32, 32, 0.18);
  color: rgba(255, 255, 255, 0.72);
  font: 10px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  padding: 0;
  cursor: pointer;
  opacity: 0.52;
  backdrop-filter: blur(6px);
}
#${ROOT_ID} .${NODE_CLASS}.role-user { border-radius: 5px; }
#${ROOT_ID} .${NODE_CLASS}.role-assistant { border-radius: 999px; }
#${ROOT_ID} .${NODE_CLASS}:hover,
#${ROOT_ID} .${NODE_CLASS}.${ACTIVE_CLASS} {
  opacity: 1;
  transform: scale(1.08);
  background: rgba(32, 32, 32, 0.72);
}
@media (prefers-color-scheme: light) {
  #${ROOT_ID} .${NODE_CLASS} {
    background: rgba(255, 255, 255, 0.68);
    color: rgba(30, 30, 30, 0.78);
  }
  #${ROOT_ID} .${NODE_CLASS}:hover,
  #${ROOT_ID} .${NODE_CLASS}.${ACTIVE_CLASS} {
    background: rgba(255, 255, 255, 0.95);
  }
}
`
    document.documentElement.appendChild(style)
  }
}
