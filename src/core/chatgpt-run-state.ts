import { ChatGPTAdapter } from "~adapters/chatgpt"
import { SITE_IDS } from "~constants"
import { TabManager } from "~core/tab-manager"

export type ChatGPTRunState =
  | "generating"
  | "awaiting-approval"
  | "tool-transition"
  | "ready"
  | "unknown"

export interface ChatGPTComposerSignals {
  state: ChatGPTRunState
  hasStopButton: boolean
  hasSendButton: boolean
  hasPendingApproval: boolean
  hasComposer: boolean
  hasIdleAction: boolean
  hasActiveAssistantTurn: boolean
  hasLatestAssistantMessage: boolean
  hasLatestAssistantCompletionAction: boolean
  approvalTransitionActive: boolean
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
const ASSISTANT_TURN_SELECTOR = '[data-turn="assistant"]'
const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]'
const ACTIVE_ASSISTANT_RESPONSE_SELECTOR =
  '[data-turn="assistant"] [data-streaming-response-status]'
const COMPLETION_ACTION_SELECTOR = '[data-testid="copy-turn-action-button"]'
const TAB_COMPLETION_SETTLE_MS = 1600
const TAB_COMPLETION_POLL_MS = 250

interface ApprovalTransitionLatch {
  conversationKey: string
  active: boolean
  assistantTurnKey: string | null
  assistantTurnIndex: number | null
}

interface PendingTabCompletion {
  timerId: number
  quietSince: number | null
}

interface ChatGPTAdapterBridgePrototype {
  isGenerating(this: ChatGPTAdapter): boolean
  __ophelRunStateBridgeInstalled__?: boolean
}

interface TabManagerBridgePrototype {
  onAiComplete(this: TabManager): void
  __ophelChatGPTCompletionBridgeInstalled__?: boolean
}

interface LatestAssistantTurnSignals {
  key: string | null
  index: number | null
  hasAssistantMessage: boolean
  hasCompletionAction: boolean
}

const approvalTransitionLatch: ApprovalTransitionLatch = {
  conversationKey: "",
  active: false,
  assistantTurnKey: null,
  assistantTurnIndex: null,
}

const pendingTabCompletions = new WeakMap<TabManager, PendingTabCompletion>()

function getConversationKey(): string {
  if (typeof window === "undefined") return "document"
  return `${window.location.origin}${window.location.pathname}`
}

function syncApprovalTransitionConversation(): void {
  const conversationKey = getConversationKey()
  if (approvalTransitionLatch.conversationKey === conversationKey) return

  approvalTransitionLatch.conversationKey = conversationKey
  approvalTransitionLatch.active = false
  approvalTransitionLatch.assistantTurnKey = null
  approvalTransitionLatch.assistantTurnIndex = null
}

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

function parseTurnIndex(turn: Element): number | null {
  const testId = turn.getAttribute("data-testid") || ""
  const match = testId.match(/^conversation-turn-(\d+)$/)
  if (!match) return null

  const index = Number.parseInt(match[1], 10)
  return Number.isFinite(index) ? index : null
}

function getLatestAssistantTurn(root: ParentNode): LatestAssistantTurnSignals {
  const turns = Array.from(root.querySelectorAll(ASSISTANT_TURN_SELECTOR)).filter(
    (turn) => turn instanceof HTMLElement && turn.isConnected && !turn.closest(".gh-main-panel"),
  )
  const latestTurn = turns[turns.length - 1]

  if (!(latestTurn instanceof HTMLElement)) {
    return {
      key: null,
      index: null,
      hasAssistantMessage: false,
      hasCompletionAction: false,
    }
  }

  const key =
    latestTurn.getAttribute("data-turn-id") ||
    latestTurn.getAttribute("data-turn-id-container") ||
    latestTurn.getAttribute("data-testid")
  const assistantMessage = latestTurn.querySelector(ASSISTANT_MESSAGE_SELECTOR)
  const completionAction = latestTurn.querySelector(COMPLETION_ACTION_SELECTOR)
  const hasCompletionAction =
    completionAction instanceof HTMLButtonElement &&
    completionAction.isConnected &&
    isButtonEnabled(completionAction)

  return {
    key,
    index: parseTurnIndex(latestTurn),
    hasAssistantMessage: assistantMessage instanceof HTMLElement && assistantMessage.isConnected,
    hasCompletionAction,
  }
}

function isTurnAtOrAfterApproval(latestTurn: LatestAssistantTurnSignals): boolean {
  if (
    approvalTransitionLatch.assistantTurnIndex !== null &&
    latestTurn.index !== null
  ) {
    return latestTurn.index >= approvalTransitionLatch.assistantTurnIndex
  }

  if (approvalTransitionLatch.assistantTurnKey && latestTurn.key) {
    return latestTurn.key === approvalTransitionLatch.assistantTurnKey
  }

  return true
}

function isChatGPTBusyState(state: ChatGPTRunState): boolean {
  return state === "generating" || state === "awaiting-approval" || state === "tool-transition"
}

function isChatGPTCompletionConfirmed(signals: ChatGPTComposerSignals): boolean {
  if (isChatGPTBusyState(signals.state)) return false

  return (
    signals.state === "ready" ||
    (signals.hasLatestAssistantMessage &&
      !signals.hasStopButton &&
      !signals.hasPendingApproval &&
      !signals.hasActiveAssistantTurn &&
      !signals.approvalTransitionActive)
  )
}

function getTabManagerAdapter(manager: TabManager): { getSiteId?: () => string } | null {
  return (manager as unknown as { adapter?: { getSiteId?: () => string } }).adapter || null
}

function installChatGPTAdapterRunStateBridge(): void {
  const prototype = ChatGPTAdapter.prototype as unknown as ChatGPTAdapterBridgePrototype
  if (prototype.__ophelRunStateBridgeInstalled__) return

  const originalIsGenerating = prototype.isGenerating
  prototype.isGenerating = function isGeneratingWithToolState(this: ChatGPTAdapter): boolean {
    if (originalIsGenerating.call(this)) return true

    const signals = getChatGPTComposerSignals()
    return isChatGPTBusyState(signals.state)
  }
  prototype.__ophelRunStateBridgeInstalled__ = true
}

function installChatGPTTabCompletionBridge(): void {
  const prototype = TabManager.prototype as unknown as TabManagerBridgePrototype
  if (prototype.__ophelChatGPTCompletionBridgeInstalled__) return

  const originalOnAiComplete = prototype.onAiComplete

  prototype.onAiComplete = function onAiCompleteAfterChatGPTSettles(this: TabManager): void {
    const adapter = getTabManagerAdapter(this)
    if (adapter?.getSiteId?.() !== SITE_IDS.CHATGPT) {
      originalOnAiComplete.call(this)
      return
    }

    if (pendingTabCompletions.has(this)) return

    const pending: PendingTabCompletion = {
      timerId: 0,
      quietSince: null,
    }

    const poll = () => {
      const signals = getChatGPTComposerSignals()

      if (!isChatGPTCompletionConfirmed(signals)) {
        pending.quietSince = null
      } else if (pending.quietSince === null) {
        pending.quietSince = Date.now()
      } else if (Date.now() - pending.quietSince >= TAB_COMPLETION_SETTLE_MS) {
        pendingTabCompletions.delete(this)
        originalOnAiComplete.call(this)
        return
      }

      pending.timerId = window.setTimeout(poll, TAB_COMPLETION_POLL_MS)
      pendingTabCompletions.set(this, pending)
    }

    pending.timerId = window.setTimeout(poll, TAB_COMPLETION_POLL_MS)
    pendingTabCompletions.set(this, pending)
  }

  prototype.__ophelChatGPTCompletionBridgeInstalled__ = true
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
  syncApprovalTransitionConversation()

  const hasPendingApproval = hasPendingChatGPTToolApproval(root)
  const hasStopButton = findVisibleElement(root, STOP_BUTTON_SELECTORS) !== null
  const hasSendButton = findVisibleChatGPTSendButton(root) !== null
  const hasComposer = findVisibleElement(root, COMPOSER_SELECTORS) !== null
  const hasIdleAction = findVisibleElement(root, IDLE_ACTION_SELECTORS) !== null
  const hasActiveAssistantTurn =
    findVisibleElement(root, [ACTIVE_ASSISTANT_RESPONSE_SELECTOR]) !== null
  const latestAssistantTurn = getLatestAssistantTurn(root)

  if (hasPendingApproval) {
    approvalTransitionLatch.active = true
    approvalTransitionLatch.assistantTurnKey = latestAssistantTurn.key
    approvalTransitionLatch.assistantTurnIndex = latestAssistantTurn.index
  } else if (
    approvalTransitionLatch.active &&
    !hasStopButton &&
    !hasActiveAssistantTurn &&
    latestAssistantTurn.hasAssistantMessage &&
    isTurnAtOrAfterApproval(latestAssistantTurn)
  ) {
    approvalTransitionLatch.active = false
    approvalTransitionLatch.assistantTurnKey = null
    approvalTransitionLatch.assistantTurnIndex = null
  }

  let state: ChatGPTRunState = "unknown"

  if (hasPendingApproval) {
    state = "awaiting-approval"
  } else if (hasStopButton || hasActiveAssistantTurn) {
    // 网页搜索和工具调用期间，ChatGPT 可能恢复 send-button 并移除 stop-button，
    // 但当前助手回合仍保留 data-streaming-response-status。
    state = "generating"
  } else if (approvalTransitionLatch.active) {
    // 审批卡消失不等于工具调用完成。等待对应助手回合转为正式的
    // data-message-author-role="assistant"，而不是依赖后台可能延迟挂载的复制按钮。
    state = "tool-transition"
  } else if (hasComposer && hasIdleAction) {
    // send-button 只代表当前允许继续输入，并不代表上一轮任务已经完成。
    // 只有在不存在活动助手回合、审批和工具过渡时，才可接收队列内容。
    state = "ready"
  }

  return {
    state,
    hasStopButton,
    hasSendButton,
    hasPendingApproval,
    hasComposer,
    hasIdleAction,
    hasActiveAssistantTurn,
    hasLatestAssistantMessage: latestAssistantTurn.hasAssistantMessage,
    hasLatestAssistantCompletionAction: latestAssistantTurn.hasCompletionAction,
    approvalTransitionActive: approvalTransitionLatch.active,
  }
}

export function isChatGPTReadyForQueueItem(root: ParentNode = document): boolean {
  return getChatGPTComposerSignals(root).state === "ready"
}

installChatGPTAdapterRunStateBridge()
installChatGPTTabCompletionBridge()
