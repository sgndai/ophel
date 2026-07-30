/**
 * Queue Store - Zustand 状态管理
 *
 * 管理提示词队列状态（纯内存，不持久化）
 * 预留 type 字段以支持未来扩展（收藏夹、快捷操作等）
 */

import { create } from "zustand"

import type { PromptActionRunMode, PromptQuoteReference } from "~core/prompt-action-types"

// ==================== 类型定义 ====================

export type QueueItemStatus = "pending" | "sending" | "sent" | "failed" | "skipped"

export type QueueRunPhase =
  | "idle"
  | "submitting"
  | "generating"
  | "blocked-editor"
  | "paused"
  | "failed"
  | "completed"

export type QueueBlockedReason = "editor-content" | "editor-unknown" | null

export interface QueueRunState {
  runId: string | null
  conversationKey: string | null
  total: number
  current: number
  completed: number
  activeItemId: string | null
  phase: QueueRunPhase
  blockedReason: QueueBlockedReason
  nextDispatchAt: number | null
}

export interface QueueItem {
  id: string
  content: string
  createdAt: number
  status: QueueItemStatus
  ordinal: number
  runId: string
  /** 预留扩展：队列项类型，默认 'prompt' */
  type?: "prompt" | "bookmark" | "shortcut"
  metadata?: QueueItemMetadata
}

export interface QueueItemMetadata {
  source?: "prompt-library" | "prompt-queue" | "quick-follow-up" | "inline-selection"
  promptId?: string
  promptTitle?: string
  chainId?: string
  chainTitle?: string
  stepId?: string
  stepIndex?: number
  stepTotal?: number
  quoteRef?: PromptQuoteReference
  quoteMarkerKind?: "full" | "ref"
  runMode?: PromptActionRunMode
}

export interface QueueEnqueueInput {
  content: string
  metadata?: QueueItemMetadata
}

interface QueueState {
  items: QueueItem[]
  isProcessing: boolean
  isPaused: boolean
  run: QueueRunState

  enqueue: (content: string, metadata?: QueueItemMetadata) => QueueItem
  enqueueMany: (contents: Array<string | QueueEnqueueInput>) => QueueItem[]
  dequeue: () => QueueItem | null
  remove: (id: string) => void
  updateContent: (id: string, content: string) => void
  updateStatus: (id: string, status: QueueItemStatus) => void
  markSubmitting: (item: QueueItem) => void
  markGenerating: (item: QueueItem) => void
  markCurrentComplete: () => void
  markBlocked: (reason: Exclude<QueueBlockedReason, null>) => void
  clearBlocked: () => void
  markFailed: (itemId: string) => void
  retryFailed: (itemId: string) => void
  skipFailed: (itemId: string) => void
  discardFailed: (itemId: string) => void
  clear: () => void
  pause: () => void
  resume: () => void
}

// ==================== Store 创建 ====================

const createIdleRunState = (): QueueRunState => ({
  runId: null,
  conversationKey: null,
  total: 0,
  current: 0,
  completed: 0,
  activeItemId: null,
  phase: "idle",
  blockedReason: null,
  nextDispatchAt: null,
})

const createRunId = (): string => `qr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

const getConversationKey = (): string | null => {
  if (typeof window === "undefined") return null
  return `${window.location.origin}${window.location.pathname}`
}

const hasActiveItems = (items: QueueItem[]): boolean =>
  items.some((item) => item.status === "pending" || item.status === "sending")

const createQueueItem = (
  content: string,
  metadata: QueueItemMetadata | undefined,
  runId: string,
  ordinal: number,
): QueueItem => ({
  id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  content,
  createdAt: Date.now(),
  status: "pending",
  ordinal,
  runId,
  type: "prompt",
  metadata,
})

const normalizeQueueInput = (input: string | QueueEnqueueInput): QueueEnqueueInput | null => {
  const content = typeof input === "string" ? input : input.content
  const trimmed = content.trim()
  if (!trimmed) return null

  return {
    content: trimmed,
    metadata: typeof input === "string" ? undefined : input.metadata,
  }
}

const ensureRun = (state: QueueState): QueueRunState => {
  if (state.run.runId && state.run.phase !== "completed") return state.run

  return {
    ...createIdleRunState(),
    runId: createRunId(),
    conversationKey: getConversationKey(),
  }
}

const failQueueItem = (state: QueueState, itemId: string): Partial<QueueState> => {
  const failedItem = state.items.find((item) => item.id === itemId)
  if (!failedItem) return {}

  return {
    isPaused: true,
    isProcessing: false,
    items: state.items.map((item) =>
      item.id === itemId ? { ...item, status: "failed" as const } : item,
    ),
    run: {
      ...state.run,
      current: failedItem.ordinal,
      activeItemId: itemId,
      phase: "failed",
      blockedReason: null,
      nextDispatchAt: null,
    },
  }
}

export const useQueueStore = create<QueueState>()((set, get) => ({
  items: [],
  isProcessing: false,
  isPaused: false,
  run: createIdleRunState(),

  enqueue: (content, metadata) => {
    const trimmed = content.trim()
    let createdItem: QueueItem | null = null

    set((state) => {
      const run = ensureRun(state)
      const ordinal = run.total + 1
      createdItem = createQueueItem(trimmed, metadata, run.runId as string, ordinal)

      return {
        items: [...state.items, createdItem],
        run: {
          ...run,
          total: ordinal,
          phase: state.isPaused ? "paused" : run.phase,
        },
      }
    })

    return createdItem as QueueItem
  },

  enqueueMany: (contents) => {
    const normalized = contents
      .map(normalizeQueueInput)
      .filter((input): input is QueueEnqueueInput => input !== null)

    if (normalized.length === 0) return []

    let createdItems: QueueItem[] = []
    set((state) => {
      const run = ensureRun(state)
      createdItems = normalized.map((input, index) =>
        createQueueItem(input.content, input.metadata, run.runId as string, run.total + index + 1),
      )

      return {
        items: [...state.items, ...createdItems],
        run: {
          ...run,
          total: run.total + createdItems.length,
          phase: state.isPaused ? "paused" : run.phase,
        },
      }
    })

    return createdItems
  },

  dequeue: () => {
    const { items } = get()
    const next = items.find((item) => item.status === "pending")
    if (!next) return null

    set((state) => ({
      items: state.items.map((item) =>
        item.id === next.id ? { ...item, status: "sending" as const } : item,
      ),
      isProcessing: true,
      run: {
        ...state.run,
        current: next.ordinal,
        activeItemId: next.id,
        phase: "submitting",
        blockedReason: null,
      },
    }))

    return next
  },

  remove: (id) =>
    set((state) => {
      const removed = state.items.find((item) => item.id === id)
      if (!removed) return state

      const canShrinkRun = removed.status === "pending" && removed.ordinal > state.run.current
      const items = state.items
        .filter((item) => item.id !== id)
        .map((item) =>
          canShrinkRun && item.runId === removed.runId && item.ordinal > removed.ordinal
            ? { ...item, ordinal: item.ordinal - 1 }
            : item,
        )

      return {
        items,
        isProcessing: hasActiveItems(items),
        run: {
          ...state.run,
          total: canShrinkRun ? Math.max(state.run.current, state.run.total - 1) : state.run.total,
        },
      }
    }),

  updateContent: (id, content) =>
    set((state) => ({
      items: state.items.map((item) => (item.id === id ? { ...item, content } : item)),
    })),

  updateStatus: (id, status) =>
    set((state) => {
      if (status === "failed") return failQueueItem(state, id)

      const target = state.items.find((item) => item.id === id)
      if (!target) return state

      const items = state.items.map((item) => (item.id === id ? { ...item, status } : item))
      const activeTarget = state.run.activeItemId === id
      let run = state.run

      if (activeTarget && status === "sent") {
        run = { ...run, phase: "generating", blockedReason: null }
      } else if (activeTarget && status === "pending") {
        run = {
          ...run,
          current: run.completed,
          activeItemId: null,
          phase: state.isPaused ? "paused" : "idle",
          blockedReason: null,
        }
      }

      return { items, isProcessing: hasActiveItems(items), run }
    }),

  markSubmitting: (item) =>
    set((state) => ({
      isProcessing: true,
      run: {
        ...state.run,
        current: item.ordinal,
        activeItemId: item.id,
        phase: "submitting",
        blockedReason: null,
      },
    })),

  markGenerating: (item) =>
    set((state) => ({
      isProcessing: true,
      run: {
        ...state.run,
        current: item.ordinal,
        activeItemId: item.id,
        phase: "generating",
        blockedReason: null,
      },
    })),

  markCurrentComplete: () =>
    set((state) => {
      const completed = Math.max(state.run.completed, state.run.current)
      const finished =
        state.run.total > 0 && completed >= state.run.total && !hasActiveItems(state.items)

      return {
        isProcessing: !finished && hasActiveItems(state.items),
        run: {
          ...state.run,
          completed,
          activeItemId: null,
          phase: finished ? "completed" : state.isPaused ? "paused" : "idle",
          blockedReason: null,
          nextDispatchAt: null,
        },
      }
    }),

  markBlocked: (reason) =>
    set((state) => {
      const phase = state.isPaused ? "paused" : "blocked-editor"
      if (state.run.phase === phase && state.run.blockedReason === reason) return state

      return {
        run: {
          ...state.run,
          phase,
          blockedReason: reason,
        },
      }
    }),

  clearBlocked: () =>
    set((state) => {
      if (state.run.phase !== "blocked-editor" && state.run.blockedReason === null) return state

      return {
        run: {
          ...state.run,
          phase: state.isPaused ? "paused" : "idle",
          blockedReason: null,
        },
      }
    }),

  markFailed: (itemId) => set((state) => failQueueItem(state, itemId)),

  retryFailed: (itemId) =>
    set((state) => {
      const failedItem = state.items.find((item) => item.id === itemId && item.status === "failed")
      if (!failedItem) return state

      return {
        isPaused: false,
        isProcessing: false,
        items: state.items.map((item) =>
          item.id === itemId ? { ...item, status: "pending" as const } : item,
        ),
        run: {
          ...state.run,
          current: failedItem.ordinal,
          activeItemId: null,
          phase: "idle",
          blockedReason: null,
          nextDispatchAt: null,
        },
      }
    }),

  skipFailed: (itemId) =>
    set((state) => {
      const failedItem = state.items.find((item) => item.id === itemId && item.status === "failed")
      if (!failedItem) return state

      const items = state.items.filter((item) => item.id !== itemId)
      const completed = Math.max(state.run.completed, failedItem.ordinal)
      const hasActive = hasActiveItems(items)
      const finished = state.run.total > 0 && completed >= state.run.total && !hasActive

      return {
        items,
        isPaused: false,
        isProcessing: hasActive,
        run: {
          ...state.run,
          current: failedItem.ordinal,
          completed,
          activeItemId: null,
          phase: finished ? "completed" : "idle",
          blockedReason: null,
          nextDispatchAt: null,
        },
      }
    }),

  discardFailed: (itemId) =>
    set((state) => {
      const failedItem = state.items.find((item) => item.id === itemId && item.status === "failed")
      if (!failedItem) return state

      const items = state.items
        .filter((item) => item.id !== itemId)
        .map((item) =>
          item.runId === failedItem.runId && item.ordinal > failedItem.ordinal
            ? { ...item, ordinal: item.ordinal - 1 }
            : item,
        )
      const total = Math.max(state.run.completed, state.run.total - 1)
      const hasActive = hasActiveItems(items)
      const finished = total > 0 && state.run.completed >= total && !hasActive

      return {
        items,
        isPaused: !finished && hasActive,
        isProcessing: false,
        run: {
          ...state.run,
          total,
          current: Math.min(state.run.completed, total),
          activeItemId: null,
          phase: finished ? "completed" : hasActive ? "paused" : "idle",
          blockedReason: null,
          nextDispatchAt: null,
        },
      }
    }),

  clear: () =>
    set({
      items: [],
      isProcessing: false,
      isPaused: false,
      run: createIdleRunState(),
    }),

  pause: () =>
    set((state) => ({
      isPaused: true,
      run: {
        ...state.run,
        phase: state.run.phase === "failed" ? "failed" : "paused",
      },
    })),

  resume: () =>
    set((state) => ({
      isPaused: false,
      run: {
        ...state.run,
        phase:
          state.run.phase === "failed" ? "failed" : state.run.activeItemId ? "generating" : "idle",
      },
    })),
}))

// ==================== 便捷 Hooks ====================

export const useQueueItems = () => useQueueStore((state) => state.items)
export const useQueueRun = () => useQueueStore((state) => state.run)
export const usePendingCount = () =>
  useQueueStore((state) => state.items.filter((item) => item.status === "pending").length)
export const useQueueProcessing = () => useQueueStore((state) => state.isProcessing)

// ==================== 非 React 环境使用 ====================

export const getQueueState = () => useQueueStore.getState()
export const getQueueStore = () => useQueueStore.getState()
