/** 录音面板的状态编排：设备列表、实时输入电平、计时、暂停/恢复与结果回调 */
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import {
  listInputDevices,
  MicRecorder,
  type InputDevice,
  type RecordingResult,
  type StartOptions
} from '../audio/recorder'

const devices = ref<InputDevice[]>([])
const deviceId = ref('')
const processing = ref(false)
const monitor = ref(false)
const recording = ref(false)
const paused = ref(false)
const elapsed = ref(0)
const level = shallowRef({ rms: 0, peak: 0 })
const error = ref('')
const starting = ref(false)

const recorder = new MicRecorder()
let timer: number | undefined

const elapsedLabel = computed(() => {
  const s = Math.floor(elapsed.value)
  const ms = Math.floor((elapsed.value - s) * 100)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(ms).padStart(2, '0')}`
})

/** -60..0 dB 映射成 0..1 的电平条宽度 */
const levelPercent = computed(() => {
  const db = 20 * Math.log10(Math.max(1e-6, level.value.rms))
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
})
const peakPercent = computed(() => Math.max(0, Math.min(100, level.value.peak * 100)))

recorder.onLevel = (v) => {
  level.value = v
}

export function useRecorder() {
  async function refreshDevices(): Promise<void> {
    const list = await listInputDevices()
    devices.value = list
    if (list.length && !list.some((d) => d.id === deviceId.value)) deviceId.value = list[0].id
  }

  async function start(opts: StartOptions = {}): Promise<void> {
    if (recording.value || starting.value) return
    starting.value = true
    error.value = ''
    try {
      await recorder.start({
        deviceId: (opts.deviceId ?? deviceId.value) || undefined,
        processing: processing.value,
        monitor: monitor.value,
        sampleRate: opts.sampleRate
      })
      recording.value = true
      paused.value = false
      elapsed.value = 0
      timer = window.setInterval(() => {
        elapsed.value = recorder.elapsed
      }, 100)
      await refreshDevices()
    } catch (err) {
      error.value = err instanceof Error ? err.message : '无法开始录音'
    } finally {
      starting.value = false
    }
  }

  function togglePause(): void {
    if (!recording.value) return
    paused.value = !paused.value
    recorder.setActive(!paused.value)
  }

  /** 结束并把结果交给调用方（通常是插入为一条新轨道） */
  function stop(): RecordingResult | null {
    if (!recording.value) return null
    if (timer !== undefined) {
      window.clearInterval(timer)
      timer = undefined
    }
    const result = recorder.stop()
    recording.value = false
    paused.value = false
    level.value = { rms: 0, peak: 0 }
    return result
  }

  function cancel(): void {
    if (!recording.value) return
    recorder.stop()
    if (timer !== undefined) {
      window.clearInterval(timer)
      timer = undefined
    }
    recording.value = false
    paused.value = false
    elapsed.value = 0
    level.value = { rms: 0, peak: 0 }
  }

  onBeforeUnmount(() => {
    recorder.dispose()
    if (timer !== undefined) window.clearInterval(timer)
    timer = undefined
  })

  return {
    devices,
    deviceId,
    processing,
    monitor,
    recording,
    paused,
    starting,
    elapsed,
    elapsedLabel,
    level,
    levelPercent,
    peakPercent,
    error,
    refreshDevices,
    start,
    togglePause,
    stop,
    cancel
  }
}
