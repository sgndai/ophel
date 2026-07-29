/**
 * Queue Dispatcher - 队列调度引擎
 *
 * 负责在 AI 空闲时自动从队列中取出提示词并发送。
 * 使用防抖机制：连续 2 秒检测到队列可调度状态才触发发送。
 */

import type { SiteAdapter } from "~adapters/base"
import { PollingTaskRegistry } from "~core/polling-task-registry"
import type { PromptManager } from "~core/prompt-manager"
import {
  appendQuickQuoteMarker,
  rememberQuickQuoteReferenceForContent,
  stripQuickQuoteMarkers,
} from "~core/quick-quote-marker"
import { getQueueDispatchReadiness } from "~core/queue-dispatch-readiness"
import { submitQueuePrompt } from "~core/queue-submit"
import { useSettingsStore } from "~stores/settings-store"
import type { QueueItem } from "~stores/queue-store"
import { useQueueStore } from "~stores/queue-store"
import { EVENT_MONITOR_COMPLETE, EVENT_MONITOR_START } from "~utils/messaging"

export class QueueDispatcher {
  private adapter: SiteAdapter
  private promptManager: PromptManager
  private readonly pollingTasks = new PollingTaskRegistry()
  private idleCount = 0 // 连续空闲计数
  private isDispatching = false
  private postSubmitWaitPromise: Promise<void> | null = null
  private postSubmitWaitCancel: (() => void) | null = null
  private readonly IDLE_THRESHOLD = 2 // 需要连续 N 次检测到空闲才发送
  private readonly POLL_TASK_NAME = "queue-dispatcher"
  private readonly POLL_INTERVAL = 1000 // 轮询间隔 (ms)
  private readonly POST_SUBMIT_MIN_WAIT_MS = 2500
  private readonly POST_SUBMIT_QUIET_MS = 2500
  private readonly GENERATION_START_GRACE_MS = 8000
  private readonly POST_SUBMIT_FALLBACK_CHECK_MS = 15_000
  private readonly POST_SUBMIT_MAX_WAIT_MS = 10 * 60 * 1000

  constructor(adapter: SiteAdapter, promptManager: PromptManager) {
    this.adapter = adapter
    this.promptManager = promptManager
  }

  /**
   * 启动调度循环
   */
  start(): void {
    if (this.isRunning()) return // 已在运行
    this.idleCount = 0
    this.pollingTasks.start({
      name: this.POLL_TASK_NAME,
      intervalMs: this.POLL_INTERVAL,
      runWhenHidden: true,
      run: () => this.tick(),
    })
  }

  /**
   * 停止调度循环
   */
  stop(): void {
    this.pollingTasks.stop(this.POLL_TASK_NAME)
    this.postSubmitWaitCancel?.()
    this.idleCount = 0
  }

  /**
   * 检查是否正在运行
   */
  isRunning(): boolean {
    return this.pollingTasks.isRunning(this.POLL_TASK_NAME)
  }

  private canAcceptQueueItem(): boolean {
    return getQueueDispatchReadiness(this.adapter).canAcceptQueueItem
  }

  /**
   * 每秒执行的轮询逻辑
   */
  private async tick(): Promise<void> {
    if (this.isDispatching) return
    if (this.postSubmitWaitPromise) return

    const state = useQueueStore.getState()

    if (state.isPaused) {
      this.idleCount = 0
      return
    }

    // 如果有正在发送的，优先恢复这条，不允许继续消费后续步骤。
    const sendingItems = state.items.filter((i) => i.status === "sending")
    if (sendingItems.length > 0) {
      await this.recoverSendingItem(sendingItems[0])
      return
    }

    // 如果队列为空，重置计数
    const pendingItems = state.items.filter((i) => i.status === "pending")
    if (pendingItems.length === 0) {
      this.idleCount = 0
      return
    }

    // 输入框已有内容时不从队列取下一条，避免覆盖用户输入或上一条未成功发送的内容。
    if (this.promptManager.hasEditorContent()) {
      this.idleCount = 0
      return
    }

    // ChatGPT 只有在 composer 明确可接收新提示词时才允许调度。
    // 其他站点继续沿用 adapter.isGenerating() 的兼容判断。
    if (!this.canAcceptQueueItem()) {
      this.idleCount = 0
      return
    }

    // AI 空闲，增加空闲计数
    this.idleCount++

    // 防抖：连续 N 次检测到空闲才发送
    if (this.idleCount >= this.IDLE_THRESHOLD) {
      this.idleCount = 0
      await this.dispatchNext()
    }
  }

  /**
   * 从队列头部取出一条提示词并发送
   */
  private async dispatchNext(): Promise<void> {
    if (this.isDispatching) return

    const store = useQueueStore.getState()
    const item = store.dequeue()
    if (!item) return

    this.isDispatching = true
    try {
      // 二次确认：插入前再次检查页面是否仍可接收队列项目，
      // 防止从 tick() 到这里的时间差内进入生成、审批或未知状态。
      if (!this.canAcceptQueueItem()) {
        store.updateStatus(item.id, "pending")
        this.idleCount = 0
        return
      }

      // 发送内容必须携带 quick quote marker，刷新后才能从站点消息自身恢复锚点。
      // 同时登记纯正文，作为 AI Studio 等站点发送后改写/移除 marker 的当前页 fallback。
      const visibleContent = stripQuickQuoteMarkers(item.content)
      rememberQuickQuoteReferenceForContent(visibleContent, item.metadata?.quoteRef)
      const markerKind = item.metadata?.quoteMarkerKind
      const contentToSend = appendQuickQuoteMarker(
        item.content,
        item.metadata?.quoteRef,
        markerKind ? { kind: markerKind } : undefined,
      )
      const insertOk = await this.promptManager.insertPrompt(contentToSend)
      if (!insertOk) {
        store.updateStatus(item.id, "failed")
        return
      }

      // 检查 runMode
      const runMode = item.metadata?.runMode ?? "enqueue"

      // "insert" 模式：只插入不发送
      if (runMode === "insert") {
        this.completeItem(item.id)
        return
      }

      // "enqueue" 或 "send-or-queue" 模式：插入后自动发送
      // 获取当前用户的快捷键设置
      const submitShortcut =
        useSettingsStore.getState().settings.features?.prompts?.submitShortcut ?? "enter"

      // 队列提交在 ChatGPT 上只允许点击明确可用的 send-button；其他站点保持原逻辑。
      const submitOk = await submitQueuePrompt(this.adapter, this.promptManager, submitShortcut)
      if (!submitOk) {
        // 插入后确认超时分两类：内容仍在编辑器中才保留 sending 等待重试；
        // 编辑器已清空通常表示站点已接收，只是确认窗口太短。
        if (this.isItemContentInEditor(item)) {
          store.updateStatus(item.id, "sending")
        } else {
          this.completeItem(item.id)
          this.startPostSubmitWait()
        }
        this.idleCount = 0
        return
      }

      // 发送已经确认，先从队列 UI 中移除；调度器内部继续等待回复结束后再释放下一条。
      this.completeItem(item.id)
      this.startPostSubmitWait()
    } catch (error) {
      console.error("[QueueDispatcher] 发送失败:", error)
      store.updateStatus(item.id, this.isItemContentInEditor(item) ? "sending" : "pending")
      this.idleCount = 0
    } finally {
      this.isDispatching = false
    }
  }

  private normalizeContent(content: string): string {
    return content
      .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  }

  private isItemContentInEditor(item: QueueItem): boolean {
    const editorContent = this.normalizeContent(this.promptManager.getCurrentEditorContent())
    if (!editorContent) return false

    const itemContent = this.normalizeContent(item.content)
    const visibleItemContent = this.normalizeContent(stripQuickQuoteMarkers(item.content))

    return [itemContent, visibleItemContent].some(
      (content) =>
        content &&
        (editorContent === content ||
          editorContent.includes(content) ||
          content.includes(editorContent)),
    )
  }

  private completeItem(itemId: string): void {
    const store = useQueueStore.getState()
    store.updateStatus(itemId, "sent")
    store.remove(itemId)
  }

  private async recoverSendingItem(item: QueueItem): Promise<void> {
    if (!this.canAcceptQueueItem()) {
      this.idleCount = 0
      return
    }

    if (!this.isItemContentInEditor(item)) {
      // 输入框已清空或内容已被用户处理，避免永久卡在 sending。
      this.completeItem(item.id)
      this.idleCount = 0
      return
    }

    this.idleCount++
    if (this.idleCount < this.IDLE_THRESHOLD) return

    this.idleCount = 0
    this.isDispatching = true
    try {
      const submitShortcut =
        useSettingsStore.getState().settings.features?.prompts?.submitShortcut ?? "enter"
      const rawEditorContent = this.promptManager.getCurrentEditorContent()
      const markerKind = item.metadata?.quoteMarkerKind
      const editorContent = appendQuickQuoteMarker(
        rawEditorContent,
        item.metadata?.quoteRef,
        markerKind ? { kind: markerKind } : undefined,
      )
      rememberQuickQuoteReferenceForContent(
        stripQuickQuoteMarkers(editorContent),
        item.metadata?.quoteRef,
      )

      if (editorContent && editorContent !== rawEditorContent.trim()) {
        await this.promptManager.insertPrompt(editorContent)
      }

      const submitOk = await submitQueuePrompt(this.adapter, this.promptManager, submitShortcut)

      if (!submitOk) return

      this.completeItem(item.id)
      this.startPostSubmitWait()
    } catch (error) {
      console.error("[QueueDispatcher] 重试发送失败:", error)
    } finally {
      this.isDispatching = false
    }
  }

  private getConversationKey(): string {
    return `${window.location.origin}${window.location.pathname}`
  }

  private getConversationObservationRoot(): Node {
    const scrollContainer = this.adapter.getScrollContainer()
    if (scrollContainer instanceof Node) return scrollContainer

    const responseSelector = this.adapter.getResponseContainerSelector()
    if (responseSelector) {
      try {
        const responseRoot = document.querySelector(responseSelector)
        if (responseRoot) return responseRoot
      } catch {
        // 选择器无效时退回页面主体。
      }
    }

    return document.body || document.documentElement
  }

  private hasRelevantConversationMutation(records: MutationRecord[]): boolean {
    const isInsideOphelPanel = (node: Node): boolean => {
      const element = node instanceof Element ? node : node.parentElement
      return Boolean(element?.closest(".gh-main-panel"))
    }

    return records.some((record) => {
      if (isInsideOphelPanel(record.target)) return false
      if (record.type !== "childList") return true

      const changedNodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]
      return changedNodes.length === 0 || changedNodes.some((node) => !isInsideOphelPanel(node))
    })
  }

  private waitForConversationIdleAfterSubmit(): Promise<void> {
    return new Promise((resolve) => {
      const startedAt = Date.now()
      const conversationKey = this.getConversationKey()
      let lastActivityAt = startedAt
      let readiness = getQueueDispatchReadiness(this.adapter)
      let sawBusyState = !readiness.canAcceptQueueItem
      let done = false
      let evaluationQueued = false
      let settleTimerId: number | null = null
      let graceTimerId: number | null = null
      let fallbackTimerId: number | null = null
      let maxWaitTimerId: number | null = null
      let observer: MutationObserver | null = null

      const clearSettleTimer = (): void => {
        if (settleTimerId === null) return
        window.clearTimeout(settleTimerId)
        settleTimerId = null
      }

      const cleanup = (): void => {
        clearSettleTimer()
        if (graceTimerId !== null) window.clearTimeout(graceTimerId)
        if (fallbackTimerId !== null) window.clearInterval(fallbackTimerId)
        if (maxWaitTimerId !== null) window.clearTimeout(maxWaitTimerId)
        observer?.disconnect()
        window.removeEventListener("message", onMonitorMessage)
        document.removeEventListener("visibilitychange", onPassiveSignal)
        window.removeEventListener("focus", onPassiveSignal)
        window.removeEventListener("popstate", onPassiveSignal)
        window.removeEventListener("hashchange", onPassiveSignal)
      }

      const finish = (): void => {
        if (done) return
        done = true
        cleanup()
        resolve()
      }

      const evaluate = (activityObserved = false): void => {
        if (done) return

        if (this.getConversationKey() !== conversationKey) {
          console.warn("[QueueDispatcher] 对话已切换，暂停队列以避免发送到错误会话")
          useQueueStore.getState().pause()
          finish()
          return
        }

        const now = Date.now()
        if (activityObserved) lastActivityAt = now

        readiness = getQueueDispatchReadiness(this.adapter)
        if (!readiness.canAcceptQueueItem) {
          sawBusyState = true
          lastActivityAt = now
          clearSettleTimer()
          return
        }

        const waited = now - startedAt
        const activityWasObservable = sawBusyState || waited >= this.GENERATION_START_GRACE_MS
        if (waited < this.POST_SUBMIT_MIN_WAIT_MS || !activityWasObservable) {
          clearSettleTimer()
          return
        }

        const remainingQuietMs = Math.max(
          0,
          this.POST_SUBMIT_QUIET_MS - (now - lastActivityAt),
        )
        if (settleTimerId !== null) return

        settleTimerId = window.setTimeout(() => {
          settleTimerId = null
          if (done) return

          const settledReadiness = getQueueDispatchReadiness(this.adapter)
          if (settledReadiness.canAcceptQueueItem) {
            finish()
          } else {
            sawBusyState = true
            lastActivityAt = Date.now()
          }
        }, remainingQuietMs)
      }

      const scheduleEvaluation = (activityObserved = false): void => {
        if (done) return
        if (activityObserved) {
          lastActivityAt = Date.now()
          clearSettleTimer()
        }
        if (evaluationQueued) return

        evaluationQueued = true
        queueMicrotask(() => {
          evaluationQueued = false
          evaluate(activityObserved)
        })
      }

      const onPassiveSignal = (): void => scheduleEvaluation(false)

      const onMonitorMessage = (event: MessageEvent): void => {
        if (event.origin !== window.location.origin) return
        const type = event.data?.type
        if (type !== EVENT_MONITOR_START && type !== EVENT_MONITOR_COMPLETE) return
        scheduleEvaluation(true)
      }

      const observationRoot = this.getConversationObservationRoot()
      if (typeof MutationObserver !== "undefined") {
        observer = new MutationObserver((records) => {
          if (this.hasRelevantConversationMutation(records)) {
            scheduleEvaluation(true)
          }
        })
        observer.observe(observationRoot, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["aria-disabled", "disabled", "data-disabled", "data-testid"],
        })
      }

      window.addEventListener("message", onMonitorMessage)
      document.addEventListener("visibilitychange", onPassiveSignal)
      window.addEventListener("focus", onPassiveSignal)
      window.addEventListener("popstate", onPassiveSignal)
      window.addEventListener("hashchange", onPassiveSignal)

      graceTimerId = window.setTimeout(
        () => scheduleEvaluation(false),
        this.GENERATION_START_GRACE_MS,
      )
      fallbackTimerId = window.setInterval(
        () => scheduleEvaluation(false),
        this.POST_SUBMIT_FALLBACK_CHECK_MS,
      )
      maxWaitTimerId = window.setTimeout(() => {
        console.warn("[QueueDispatcher] 等待回复结束超时，释放队列调度锁")
        finish()
      }, this.POST_SUBMIT_MAX_WAIT_MS)

      this.postSubmitWaitCancel = finish
      scheduleEvaluation(false)
    })
  }

  private startPostSubmitWait(): void {
    if (this.postSubmitWaitPromise) return

    this.postSubmitWaitPromise = this.waitForConversationIdleAfterSubmit()
      .catch((error) => {
        console.error("[QueueDispatcher] 等待回复结束失败:", error)
      })
      .finally(() => {
        this.postSubmitWaitPromise = null
        this.postSubmitWaitCancel = null
        this.idleCount = 0
      })
  }

  /**
   * 立即发送一条提示词（不入队，直接发送）
   * 用于 AI 空闲时的直接发送场景
   */
  async sendImmediately(
    content: string,
    submitShortcut?: "enter" | "ctrlEnter",
    metadata?: QueueItem["metadata"],
  ): Promise<boolean> {
    try {
      const visibleContent = stripQuickQuoteMarkers(content)
      rememberQuickQuoteReferenceForContent(visibleContent, metadata?.quoteRef)
      const markerKind = metadata?.quoteMarkerKind
      const contentToSend = appendQuickQuoteMarker(
        content,
        metadata?.quoteRef,
        markerKind ? { kind: markerKind } : undefined,
      )
      const insertOk = await this.promptManager.insertPrompt(contentToSend)
      if (!insertOk) return false

      const submitOk = await this.promptManager.submitPrompt(submitShortcut)
      return submitOk
    } catch (error) {
      console.error("[QueueDispatcher] 立即发送失败:", error)
      return false
    }
  }

  /**
   * 当 AI 当前空闲时，立即处理一条队列任务，不等待轮询防抖。
   */
  async processNextNow(): Promise<boolean> {
    const state = useQueueStore.getState()

    if (state.isPaused) return false
    if (this.isDispatching) return false
    if (this.postSubmitWaitPromise) return false
    if (!this.canAcceptQueueItem()) return false
    if (this.promptManager.hasEditorContent()) return false

    const hasSending = state.items.some((item) => item.status === "sending")
    if (hasSending) return false

    const hasPending = state.items.some((item) => item.status === "pending")
    if (!hasPending) return false

    this.idleCount = 0
    await this.dispatchNext()
    return true
  }
}
