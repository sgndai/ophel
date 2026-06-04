// ==UserScript==
// @name         Ophel Message Navigator Prototype
// @namespace    https://github.com/sgndai/ophel
// @version      0.1.0
// @description  Lightweight user/assistant message navigator for ChatGPT, Gemini and DeepSeek.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://gemini.google.com/*
// @match        https://chat.deepseek.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict'

  const ROOT_ID = 'ophel-message-navigator'
  const STYLE_ID = 'ophel-message-navigator-style'
  const NODE_CLASS = 'ophel-message-nav-node'
  const ACTIVE_CLASS = 'is-active'
  const REFRESH_DEBOUNCE_MS = 180
  const PREVIEW_MAX_LENGTH = 120

  let root = null
  let items = []
  let activeIndex = -1
  let refreshTimer = null
  let scrollRaf = null
  let observer = null

  const site = getSite()
  if (!site) return

  injectStyles()
  mountRoot()
  refresh()
  observe()

  document.addEventListener('keydown', handleKeyDown, true)
  window.addEventListener('scroll', handleScroll, { passive: true, capture: true })
  window.addEventListener('resize', handleScroll, { passive: true })

  function getSite() {
    const host = location.hostname
    if (host === 'chatgpt.com' || host === 'chat.openai.com') return 'chatgpt'
    if (host === 'gemini.google.com') return 'gemini'
    if (host === 'chat.deepseek.com') return 'deepseek'
    return null
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) return false
    return Boolean(target.closest([
      'input',
      'textarea',
      'select',
      'iframe',
      "[contenteditable='true']",
      "[contenteditable='']",
      "[role='textbox']",
      '.gh-main-panel',
      '.gh-queue-panel',
      '.gh-queue-capsule',
      '.gh-interactive',
    ].join(',')))
  }

  function handleKeyDown(event) {
    if (event.defaultPrevented) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (isEditableTarget(event.target)) return

    const moved = moveActive(event.key === 'ArrowDown' ? 1 : -1)
    if (!moved) return

    event.preventDefault()
    event.stopPropagation()
  }

  function handleScroll() {
    if (scrollRaf !== null) return
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null
      syncActiveFromViewport()
    })
  }

  function observe() {
    const target = getObserveTarget()
    if (!target) return
    observer?.disconnect()
    observer = new MutationObserver(() => scheduleRefresh())
    observer.observe(target, { childList: true, subtree: true })
  }

  function getObserveTarget() {
    if (site === 'chatgpt') return document.querySelector('main') || document.body
    if (site === 'gemini') return document.querySelector('infinite-scroller.chat-history') || document.body
    if (site === 'deepseek') return document.querySelector('.ds-scroll-area:has(.ds-message)') || document.body
    return document.body
  }

  function scheduleRefresh(delay = REFRESH_DEBOUNCE_MS) {
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      refresh()
    }, delay)
  }

  function refresh() {
    mountRoot()
    const nextItems = collectItems()
    const oldSignature = items.map((item) => item.id).join('|')
    const newSignature = nextItems.map((item) => item.id).join('|')
    items = nextItems
    if (oldSignature !== newSignature) render()
    syncActiveFromViewport()
  }

  function collectItems() {
    if (site === 'chatgpt') return collectChatGPTItems()
    if (site === 'gemini') return collectGeminiItems()
    if (site === 'deepseek') return collectDeepSeekItems()
    return []
  }

  function collectChatGPTItems() {
    const container = document.querySelector('main') || document
    const nodes = Array.from(container.querySelectorAll("[data-message-author-role='user'], [data-message-author-role='assistant']"))
      .filter(isVisibleElement)

    return nodes.map((element, order) => {
      const role = element.getAttribute('data-message-author-role') === 'assistant' ? 'assistant' : 'user'
      const messageId = element.getAttribute('data-message-id')
      const turnId = element.closest('[data-turn-id]')?.getAttribute('data-turn-id')
      return buildItem({
        site: 'chatgpt',
        role,
        element,
        order,
        idPart: messageId || turnId || String(order),
      })
    })
  }

  function collectGeminiItems() {
    const container = document.querySelector('infinite-scroller.chat-history') || document
    const nodes = Array.from(container.querySelectorAll('user-query, model-response')).filter(isVisibleElement)

    return nodes.map((element, order) => {
      const role = element.tagName.toLowerCase() === 'model-response' ? 'assistant' : 'user'
      return buildItem({
        site: 'gemini',
        role,
        element,
        order,
        idPart: element.id || element.getAttribute('data-message-id') || String(order),
      })
    })
  }

  function collectDeepSeekItems() {
    const container = document.querySelector('.ds-scroll-area:has(.ds-message)') || document
    const nodes = Array.from(container.querySelectorAll('.ds-message')).filter(isVisibleElement)

    return nodes.map((element, order) => {
      const role = element.querySelector('.ds-markdown') ? 'assistant' : 'user'
      return buildItem({
        site: 'deepseek',
        role,
        element,
        order,
        idPart: `${order}:${truncateText(element.textContent || '', 32)}`,
      })
    })
  }

  function buildItem({ site, role, element, order, idPart }) {
    return {
      id: `${site}:${role}:${idPart}`,
      role,
      element,
      order,
      textPreview: truncateText(extractText(element)),
    }
  }

  function extractText(element) {
    const clone = element.cloneNode(true)
    clone.querySelectorAll('button, svg, mat-icon, .sr-only, .cdk-visually-hidden, .gh-inline-bookmark').forEach((node) => node.remove())
    return normalizeText(clone.textContent || '')
  }

  function isVisibleElement(element) {
    if (!(element instanceof HTMLElement)) return false
    if (!element.isConnected) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  function normalizeText(value) {
    return (value || '').replace(/\s+/g, ' ').trim()
  }

  function truncateText(value, maxLength = PREVIEW_MAX_LENGTH) {
    const normalized = normalizeText(value)
    if (normalized.length <= maxLength) return normalized
    return `${normalized.slice(0, maxLength)}…`
  }

  function mountRoot() {
    if (root?.isConnected) return
    root = document.getElementById(ROOT_ID)
    if (!root) {
      root = document.createElement('div')
      root.id = ROOT_ID
      root.setAttribute('aria-label', 'Message navigator')
      document.body.appendChild(root)
    }
  }

  function render() {
    if (!root) return
    const fragment = document.createDocumentFragment()
    for (const item of items) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `${NODE_CLASS} role-${item.role}`
      button.dataset.id = item.id
      button.title = `${item.role === 'user' ? 'User' : 'AI'}: ${item.textPreview}`
      button.textContent = item.role === 'user' ? 'U' : 'A'
      button.addEventListener('click', () => scrollToItem(item))
      fragment.appendChild(button)
    }
    root.replaceChildren(fragment)
  }

  function syncActiveFromViewport() {
    if (items.length === 0) {
      setActiveIndex(-1)
      return
    }

    const pivot = Math.max(80, window.innerHeight * 0.18)
    let bestIndex = 0
    let bestDistance = Number.POSITIVE_INFINITY

    items.forEach((item, index) => {
      if (!item.element.isConnected) return
      const rect = item.element.getBoundingClientRect()
      if (rect.bottom < 0 || rect.top > window.innerHeight) return
      const distance = Math.abs(rect.top - pivot)
      if (distance < bestDistance) {
        bestDistance = distance
        bestIndex = index
      }
    })

    setActiveIndex(bestIndex)
  }

  function setActiveIndex(index) {
    if (activeIndex === index) return
    activeIndex = index
    if (!root) return
    Array.from(root.querySelectorAll(`.${NODE_CLASS}`)).forEach((node, nodeIndex) => {
      node.classList.toggle(ACTIVE_CLASS, nodeIndex === index)
    })
  }

  function moveActive(direction) {
    if (items.length === 0) refresh()
    if (items.length === 0) return false
    const current = activeIndex >= 0 ? activeIndex : 0
    const next = Math.min(items.length - 1, Math.max(0, current + direction))
    if (next === activeIndex) return false
    scrollToItem(items[next])
    setActiveIndex(next)
    return true
  }

  function scrollToItem(item) {
    if (!item.element.isConnected) {
      scheduleRefresh(0)
      return
    }
    item.element.scrollIntoView({ block: 'start', behavior: 'instant' })
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return
    const style = document.createElement('style')
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
  font: 10px/1 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
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
}`
    document.documentElement.appendChild(style)
  }
})()
