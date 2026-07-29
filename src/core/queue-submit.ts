import type { SiteAdapter } from "~adapters/base"
import { SITE_IDS } from "~constants/defaults"
import {
  findVisibleChatGPTSendButton,
  getChatGPTComposerSignals,
} from "~core/chatgpt-run-state"
import type { PromptManager } from "~core/prompt-manager"

const CHATGPT_SEND_BUTTON_WAIT_MS = 2000
const CHATGPT_SUBMIT_CONFIRMATION_WAIT_MS = 1800
const CHATGPT_SUBMIT_POLL_MS = 50

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeEditorContent(content: string): string {
  return content.replace(/[\u200B\u200C\u200D\uFEFF]/g, "").trim()
}

async function waitForChatGPTSendButton(): Promise<HTMLButtonElement | null> {
  const deadline = Date.now() + CHATGPT_SEND_BUTTON_WAIT_MS

  while (Date.now() < deadline) {
    const signals = getChatGPTComposerSignals()

    // 插入内容后若页面突然进入生成或审批态，立即停止本次自动提交。
    if (signals.hasStopButton || signals.hasPendingApproval) {
      return null
    }

    const sendButton = findVisibleChatGPTSendButton()
    if (sendButton) return sendButton

    await delay(CHATGPT_SUBMIT_POLL_MS)
  }

  return null
}

async function waitForChatGPTSubmitConfirmation(
  promptManager: PromptManager,
  initialContent: string,
): Promise<boolean> {
  const normalizedInitial = normalizeEditorContent(initialContent)
  if (!normalizedInitial) return false

  const deadline = Date.now() + CHATGPT_SUBMIT_CONFIRMATION_WAIT_MS

  while (Date.now() < deadline) {
    const signals = getChatGPTComposerSignals()
    if (signals.hasStopButton) return true

    const currentContent = normalizeEditorContent(promptManager.getCurrentEditorContent())
    if (!currentContent) return true

    if (
      currentContent !== normalizedInitial &&
      !currentContent.includes(normalizedInitial) &&
      !normalizedInitial.includes(currentContent)
    ) {
      return true
    }

    await delay(CHATGPT_SUBMIT_POLL_MS)
  }

  return false
}

async function submitChatGPTQueuePrompt(promptManager: PromptManager): Promise<boolean> {
  const initialContent = promptManager.getCurrentEditorContent()
  if (!normalizeEditorContent(initialContent)) return false

  const sendButton = await waitForChatGPTSendButton()
  if (!sendButton) return false

  // 队列自动发送只点击 ChatGPT 明确暴露的 send-button。
  // 不模拟 Enter，也不在点击确认超时后回退到键盘事件。
  sendButton.click()

  return waitForChatGPTSubmitConfirmation(promptManager, initialContent)
}

/**
 * 提交由提示词队列插入的内容。
 *
 * ChatGPT 使用严格模式：必须找到可见、可用的 send-button，并且只允许点击按钮。
 * 其他站点暂时维持原有 PromptManager 行为，避免改变尚未验证的平台交互。
 */
export async function submitQueuePrompt(
  adapter: SiteAdapter,
  promptManager: PromptManager,
  submitShortcut?: "enter" | "ctrlEnter",
): Promise<boolean> {
  if (adapter.getSiteId() === SITE_IDS.CHATGPT) {
    return submitChatGPTQueuePrompt(promptManager)
  }

  return promptManager.submitPrompt(submitShortcut)
}
