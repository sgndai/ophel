import type { SiteAdapter } from "~adapters/base"
import { SITE_IDS } from "~constants/defaults"
import {
  getChatGPTComposerSignals,
  type ChatGPTRunState,
} from "~core/chatgpt-run-state"

export type QueueDispatchReadinessState =
  | "ready"
  | "generating"
  | "awaiting-approval"
  | "unknown"

export interface QueueDispatchReadiness {
  state: QueueDispatchReadinessState
  canAcceptQueueItem: boolean
  reason:
    | "chatgpt-ready"
    | "chatgpt-generating"
    | "chatgpt-awaiting-approval"
    | "chatgpt-unknown"
    | "adapter-generating"
    | "adapter-idle"
  signals?: {
    hasStopButton: boolean
    hasSendButton: boolean
    hasPendingApproval: boolean
    hasComposer: boolean
    hasIdleAction: boolean
  }
}

function mapChatGPTState(state: ChatGPTRunState): QueueDispatchReadinessState {
  return state
}

export function getQueueDispatchReadiness(
  adapter: SiteAdapter,
  root: ParentNode = document,
): QueueDispatchReadiness {
  if (adapter.getSiteId() === SITE_IDS.CHATGPT) {
    const signals = getChatGPTComposerSignals(root)
    const state = mapChatGPTState(signals.state)

    return {
      state,
      canAcceptQueueItem: state === "ready",
      reason:
        state === "ready"
          ? "chatgpt-ready"
          : state === "generating"
            ? "chatgpt-generating"
            : state === "awaiting-approval"
              ? "chatgpt-awaiting-approval"
              : "chatgpt-unknown",
      signals: {
        hasStopButton: signals.hasStopButton,
        hasSendButton: signals.hasSendButton,
        hasPendingApproval: signals.hasPendingApproval,
        hasComposer: signals.hasComposer,
        hasIdleAction: signals.hasIdleAction,
      },
    }
  }

  const isGenerating = adapter.isGenerating()
  return {
    state: isGenerating ? "generating" : "ready",
    canAcceptQueueItem: !isGenerating,
    reason: isGenerating ? "adapter-generating" : "adapter-idle",
  }
}
