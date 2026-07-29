export type ChatGPTRunState = "generating" | "awaiting-approval" | "ready" | "unknown"

export interface ChatGPTComposerSignals {
  state: ChatGPTRunState
  hasStopButton: boolean
  hasSendButton: boolean
  hasPendingApproval: boolean
  hasComposer: boolean
  hasIdleAction: boolean
}

const STOP_BUTTON_SELECTORS = [
  '[data-testid="stop-button"]',
  '#composer-submit-button[aria-label*="Stop"]',
  '#composer-submit-button[aria-label*="停止"]',
]

const SEND_BUTTON_SELECTORS = [
  '[data-testid="send-button"]',
  '#composer-submit-button[aria-label="Send prompt"]',
  '#composer-submit-button[aria-label="发送提示"]',
  '#composer-submit-button[aria-label="发送"]',
]

const IDLE_ACTION_SELECTORS = [
  ...SEND_BUTTON_SELECTORS,
  'button[aria-label="Start voice mode"]',
  'button[aria-label="启动语音功能"]',
]

const COMPOSER_SELECTORS = [
  '#prompt-textarea[contenteditable="true"]',
  'form[data-type="unified-composer"] #prompt-textarea',
]

const APPROVAL_CARD_SELECTOR = '[data-testid="tool-approval-card"]'
const APPROVAL_ACTIONS_SELECTOR = '[data-testid="tool-action-buttons"]'

function isElementVisible(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false
  if (element.closest(".gh-main-panel")) return false

  const style = window.getComputedStyle(element)
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    Number.parseFloat(style.opacity || "1") === 0
  ) {
    return false
  }

  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function findVisibleElement(root: ParentNode, selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    const elements = root.querySelectorAll(selector)
    for (const element of elements) {
      if (isElementVisible(element)) return element
    }
  }

  return null
}

function isButtonEnabled(button: HTMLButtonElement): boolean {
  return (
    !button.disabled &&
    button.getAttribute("aria-disabled") !== "true" &&
    button.getAttribute("data-disabled") !== "true"
  )
}

export function hasPendingChatGPTToolApproval(root: ParentNode = document): boolean {
  const cards = root.querySelectorAll(APPROVAL_CARD_SELECTOR)

  for (const card of cards) {
    if (!isElementVisible(card)) continue

    const actions = card.querySelector(APPROVAL_ACTIONS_SELECTOR)
    if (!isElementVisible(actions)) continue

    const actionableButton = Array.from(actions.querySelectorAll("button")).find(
      (button): button is HTMLButtonElement =>
        button instanceof HTMLButtonElement && isElementVisible(button) && isButtonEnabled(button),
    )

    if (actionableButton) return true
  }

  return false
}

export function findVisibleChatGPTSendButton(root: ParentNode = document): HTMLButtonElement | null {
  const button = findVisibleElement(root, SEND_BUTTON_SELECTORS)
  return button instanceof HTMLButtonElement && isButtonEnabled(button) ? button : null
}

export function getChatGPTComposerSignals(root: ParentNode = document): ChatGPTComposerSignals {
  const hasPendingApproval = hasPendingChatGPTToolApproval(root)
  const hasStopButton = findVisibleElement(root, STOP_BUTTON_SELECTORS) !== null
  const hasSendButton = findVisibleChatGPTSendButton(root) !== null
  const hasComposer = findVisibleElement(root, COMPOSER_SELECTORS) !== null
  const hasIdleAction = findVisibleElement(root, IDLE_ACTION_SELECTORS) !== null

  let state: ChatGPTRunState = "unknown"

  if (hasPendingApproval) {
    state = "awaiting-approval"
  } else if (hasStopButton) {
    state = "generating"
  } else if (hasComposer && hasIdleAction) {
    // ChatGPT 空输入时通常显示语音按钮；队列内容插入后才切换为 send-button。
    // 因此这里表示“可接收队列内容”，实际提交仍需再次确认 send-button。
    state = "ready"
  }

  return {
    state,
    hasStopButton,
    hasSendButton,
    hasPendingApproval,
    hasComposer,
    hasIdleAction,
  }
}

export function isChatGPTReadyForQueueItem(root: ParentNode = document): boolean {
  return getChatGPTComposerSignals(root).state === "ready"
}
