import { platform } from "~platform"
import { useQueueStore } from "~stores/queue-store"
import { useSettingsStore } from "~stores/settings-store"

const FAILURE_SOUND_PRESET_ID = "brightAlert"

let installed = false
let queueUnsubscribe: (() => void) | null = null
let failureAudio: HTMLAudioElement | null = null

function clampVolume(value: number): number {
  return Math.min(1, Math.max(0.1, value))
}

function playFailureSound(): void {
  if (typeof Audio === "undefined") return

  const tabSettings = useSettingsStore.getState().settings.tab
  if (!tabSettings.notificationSound) return

  const sourceUrl = platform.getNotificationSoundUrl(FAILURE_SOUND_PRESET_ID)
  if (!sourceUrl) {
    console.warn(
      "[QueueEventSound] Failure sound URL not found for preset:",
      FAILURE_SOUND_PRESET_ID,
    )
    return
  }

  try {
    failureAudio ??= new Audio()
    failureAudio.pause()
    failureAudio.currentTime = 0
    failureAudio.volume = clampVolume(tabSettings.notificationVolume ?? 0.5)
    failureAudio.src = sourceUrl
    void failureAudio.play().catch((error) => {
      console.warn("[QueueEventSound] Failure sound playback was rejected:", error)
    })
  } catch (error) {
    console.warn("[QueueEventSound] Failed to initialize failure sound:", error)
  }
}

/**
 * 监听队列项目从非失败状态进入 failed 的跃迁。
 * 同一失败状态只播放一次；用户重试后再次失败会重新播放。
 */
export function ensureQueueEventSounds(): void {
  if (installed || typeof window === "undefined") return
  installed = true

  queueUnsubscribe = useQueueStore.subscribe((state, previousState) => {
    const failedItem = state.items.find((item) => item.status === "failed")
    if (!failedItem) return

    const wasAlreadyFailed = previousState.items.some(
      (item) => item.id === failedItem.id && item.status === "failed",
    )
    if (wasAlreadyFailed) return

    playFailureSound()
  })
}

export function destroyQueueEventSounds(): void {
  queueUnsubscribe?.()
  queueUnsubscribe = null
  installed = false

  try {
    failureAudio?.pause()
    if (failureAudio) failureAudio.currentTime = 0
  } catch {
    // 音频元素销毁失败不影响队列状态。
  }
  failureAudio = null
}
