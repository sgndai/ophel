import { platform } from "~platform"
import { useQueueStore } from "~stores/queue-store"
import { useSettingsStore } from "~stores/settings-store"

const FAILURE_SOUND_PRESET_ID = "brightAlert"
const DEFAULT_COMPLETION_SOUND_PRESET_ID = "default"

let installed = false
let queueUnsubscribe: (() => void) | null = null
let eventAudio: HTMLAudioElement | null = null

function clampVolume(value: number): number {
  return Math.min(1, Math.max(0.1, value))
}

function playQueueSound(presetId: string, label: string): void {
  if (typeof Audio === "undefined") return

  const tabSettings = useSettingsStore.getState().settings.tab
  if (!tabSettings.notificationSound) return

  const sourceUrl = platform.getNotificationSoundUrl(presetId)
  if (!sourceUrl) {
    console.warn(`[QueueEventSound] ${label} sound URL not found for preset:`, presetId)
    return
  }

  try {
    eventAudio ??= new Audio()
    eventAudio.pause()
    eventAudio.currentTime = 0
    eventAudio.volume = clampVolume(tabSettings.notificationVolume ?? 0.5)
    eventAudio.src = sourceUrl
    void eventAudio.play().catch((error) => {
      console.warn(`[QueueEventSound] ${label} sound playback was rejected:`, error)
    })
  } catch (error) {
    console.warn(`[QueueEventSound] Failed to initialize ${label} sound:`, error)
  }
}

function playFailureSound(): void {
  playQueueSound(FAILURE_SOUND_PRESET_ID, "failure")
}

function playCompletionSound(): void {
  const tabSettings = useSettingsStore.getState().settings.tab
  if (!tabSettings.showNotification) return

  playQueueSound(
    tabSettings.notificationSoundPreset || DEFAULT_COMPLETION_SOUND_PRESET_ID,
    "completion",
  )
}

/**
 * 队列失败沿用醒目的警报音；多步骤队列只在整轮真正完成时播放一次完成音。
 * 同一失败状态只播放一次，用户重试后再次失败会重新播放。
 */
export function ensureQueueEventSounds(): void {
  if (installed || typeof window === "undefined") return
  installed = true

  queueUnsubscribe = useQueueStore.subscribe((state, previousState) => {
    const failedItem = state.items.find((item) => item.status === "failed")
    if (failedItem) {
      const wasAlreadyFailed = previousState.items.some(
        (item) => item.id === failedItem.id && item.status === "failed",
      )
      if (!wasAlreadyFailed) {
        playFailureSound()
      }
    }

    const completedFullRun =
      state.run.total > 1 &&
      state.run.phase === "completed" &&
      previousState.run.phase !== "completed" &&
      previousState.run.phase !== "failed"

    if (completedFullRun) {
      playCompletionSound()
    }
  })
}

export function destroyQueueEventSounds(): void {
  queueUnsubscribe?.()
  queueUnsubscribe = null
  installed = false

  try {
    eventAudio?.pause()
    if (eventAudio) eventAudio.currentTime = 0
  } catch {
    // 音频元素销毁失败不影响队列状态。
  }
  eventAudio = null
}
