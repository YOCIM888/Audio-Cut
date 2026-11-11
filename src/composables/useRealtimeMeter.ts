/** 组件订阅实时电平表；多个组件共享引擎里的同一个 AudioWorklet 节点 */
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { audioEngine } from '../audio/engine'
import { EMPTY_METER_STATS, type MeterMode, type MeterStats } from '../audio/meter'

export function useRealtimeMeter() {
  const stats = shallowRef<MeterStats>({ ...EMPTY_METER_STATS })
  const mode = ref<MeterMode>('unavailable')
  let unsubscribe: (() => void) | null = null
  let timer: number | undefined

  onMounted(() => {
    unsubscribe = audioEngine.addMeterListener((s) => {
      stats.value = s
    })
    timer = window.setInterval(() => {
      mode.value = audioEngine.getMeterMode()
    }, 600)
  })

  onBeforeUnmount(() => {
    unsubscribe?.()
    if (timer !== undefined) window.clearInterval(timer)
  })

  function reset(): void {
    audioEngine.resetMeter()
    stats.value = { ...EMPTY_METER_STATS }
  }

  return { stats, mode, reset }
}
