<script setup lang="ts">
import { computed, ref } from 'vue'
import { useEditorStore } from '../stores/editor'
import { useToastStore } from '../stores/toast'

const editor = useEditorStore()
const toast = useToastStore()

const highPassOn = ref(true)
const highPassHz = ref(80)
const lowPassOn = ref(false)
const lowPassHz = ref(12000)
const compOn = ref(false)
const compThreshold = ref(-24)
const compRatio = ref(4)
const gateThreshold = ref(-45)
const scope = ref<'selection' | 'all'>('all')

const busy = computed(() => editor.busy.type !== null)
const scopeDisabled = computed(() => busy.value || (scope.value === 'selection' && !editor.hasSelection))
const anythingOn = computed(() => highPassOn.value || lowPassOn.value || compOn.value)

function applyEffects(): void {
  if (!anythingOn.value) {
    toast.push('info', '请至少启用一个 EQ 或压缩选项')
    return
  }
  void editor.applyEffects(
    {
      highPassHz: highPassOn.value ? highPassHz.value : null,
      lowPassHz: lowPassOn.value ? lowPassHz.value : null,
      compressor: compOn.value ? { thresholdDb: compThreshold.value, ratio: compRatio.value } : null
    },
    scope.value === 'selection'
  )
}

function applyGate(): void {
  void editor.applyGate(gateThreshold.value, scope.value === 'selection')
}

const progressText = computed(() => {
  if (editor.busy.type === 'effects') return '离线渲染中…'
  if (editor.busy.type === 'gate') return `门限处理 ${Math.round(editor.busy.progress)}%`
  return ''
})
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="field-label">作用范围</label>
        <select class="field-input" v-model="scope">
          <option value="all">全曲</option>
          <option value="selection">仅选区</option>
        </select>
      </div>
      <div class="flex items-end">
        <p v-if="scope === 'selection' && !editor.hasSelection" class="text-[11px] text-warn/80">
          未框选，将按全曲处理
        </p>
      </div>
    </div>

    <div class="panel p-3 space-y-2">
      <label class="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
        <input type="checkbox" v-model="highPassOn" />
        低切 / 高通
      </label>
      <div class="flex items-center gap-2">
        <input class="neon-range flex-1" type="range" min="20" max="800" step="10" v-model.number="highPassHz" :disabled="!highPassOn" />
        <span class="font-mono text-xs text-neon w-14 text-right">{{ highPassHz }} Hz</span>
      </div>
    </div>

    <div class="panel p-3 space-y-2">
      <label class="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
        <input type="checkbox" v-model="lowPassOn" />
        高切 / 低通
      </label>
      <div class="flex items-center gap-2">
        <input class="neon-range flex-1" type="range" min="2000" max="20000" step="100" v-model.number="lowPassHz" :disabled="!lowPassOn" />
        <span class="font-mono text-xs text-neon w-14 text-right">{{ lowPassHz }} Hz</span>
      </div>
    </div>

    <div class="panel p-3 space-y-2">
      <label class="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
        <input type="checkbox" v-model="compOn" />
        动态压缩
      </label>
      <div class="space-y-1">
        <div class="flex items-center gap-2">
          <span class="text-[11px] text-slate-500 w-12">阈值</span>
          <input class="neon-range flex-1" type="range" min="-60" max="0" step="1" v-model.number="compThreshold" :disabled="!compOn" />
          <span class="font-mono text-xs text-neon w-10 text-right">{{ compThreshold }}dB</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-[11px] text-slate-500 w-12">压缩比</span>
          <input class="neon-range flex-1" type="range" min="1.5" max="12" step="0.5" v-model.number="compRatio" :disabled="!compOn" />
          <span class="font-mono text-xs text-neon w-10 text-right">{{ compRatio.toFixed(1) }}</span>
        </div>
      </div>
    </div>

    <button class="btn btn-primary w-full py-2" :disabled="scopeDisabled || !anythingOn" @click="applyEffects">
      应用 EQ / 压缩
    </button>

    <div class="panel p-3 space-y-2">
      <label class="flex items-center gap-2 text-xs text-slate-300">
        门限降噪（Worker）
      </label>
      <div class="flex items-center gap-2">
        <input class="neon-range flex-1" type="range" min="-80" max="-20" step="1" v-model.number="gateThreshold" />
        <span class="font-mono text-xs text-neon w-12 text-right">{{ gateThreshold }} dB</span>
      </div>
      <button class="btn w-full" :disabled="scopeDisabled" @click="applyGate">应用门限降噪</button>
    </div>

    <div v-if="progressText" class="space-y-1">
      <div class="h-1.5 rounded bg-abyss-800 overflow-hidden">
        <div class="h-full bg-neon shadow-glow transition-all" :style="{ width: `${editor.busy.progress}%` }" />
      </div>
      <p class="text-[11px] text-slate-500">{{ progressText }}</p>
    </div>

    <p class="text-[11px] text-slate-600 leading-relaxed">
      EQ 与压缩使用 OfflineAudioContext 在主线程离线渲染（浏览器不允许 Worker 内使用 Web Audio 节点），
      速度远快于实时；门限降噪在 Web Worker 中按采样处理。两者都会写入音轨，可 Ctrl+Z 撤销。
    </p>
  </div>
</template>
