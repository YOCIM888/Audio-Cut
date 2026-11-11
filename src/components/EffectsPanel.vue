<script setup lang="ts">
import { computed, ref } from 'vue'
import { useEditorStore } from '../stores/editor'
import {
  CHAIN_PRESETS,
  EFFECT_KINDS,
  EFFECT_META,
  paramSpecs,
  type EffectKind,
  type ParamSpec
} from '../audio/effect-chain'

interface Card {
  id: string
  index: number
  label: string
  short: string
  hint: string
  enabled: boolean
  params: ParamSpec[]
}

const editor = useEditorStore()

const addKind = ref<EffectKind>('highpass')
const busy = computed(() => editor.busy.type !== null)
const cards = computed<Card[]>(() =>
  editor.chain.nodes.map((node, index) => ({
    id: node.id,
    index,
    label: EFFECT_META[node.kind].label,
    short: EFFECT_META[node.kind].short,
    hint: EFFECT_META[node.kind].hint,
    enabled: node.enabled,
    params: paramSpecs(node)
  }))
)
const scopeHint = computed(() => {
  if (editor.chain.scope === 'all') return '整条音轨'
  return editor.hasSelection ? '仅选区' : '选区未框选，暂按全曲'
})
const statusText = computed(() => {
  if (!cards.value.length) return '链为空'
  if (editor.chain.bypass) return 'A · 原声'
  return `B · ${editor.activeEffectCount} 个效果生效`
})

function fmt(spec: ParamSpec): string {
  return `${spec.value.toFixed(spec.digits)}${spec.unit ? ` ${spec.unit}` : ''}`
}

function onParam(id: string, key: string, e: Event): void {
  editor.updateEffect(id, { [key]: Number((e.target as HTMLInputElement).value) })
}

function onEnabled(id: string, e: Event): void {
  editor.setEffectEnabled(id, (e.target as HTMLInputElement).checked)
}

function onScope(e: Event): void {
  editor.setEffectScope((e.target as HTMLSelectElement).value as 'all' | 'selection')
}

function addEffect(): void {
  editor.addEffect(addKind.value)
}

// 「按住听原声」：瞬时旁路，松开恢复，不污染撤销栈
let rememberedBypass: boolean | null = null
function holdOriginal(): void {
  if (rememberedBypass !== null) return
  rememberedBypass = editor.chain.bypass
  editor.previewBypass(true)
}
function releaseOriginal(): void {
  if (rememberedBypass === null) return
  editor.previewBypass(rememberedBypass)
  rememberedBypass = null
}
</script>

<template>
  <div class="space-y-3">
    <!-- A/B 试听 -->
    <div class="panel p-3 space-y-2">
      <div class="flex items-center justify-between">
        <label class="field-label !mb-0">实时试听 · A/B 对比</label>
        <span class="text-[10px] font-mono" :class="editor.chain.bypass ? 'text-warn' : 'text-neon-bright'">
          {{ statusText }}
        </span>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button
          class="btn"
          :class="{ 'btn-primary': !editor.chain.bypass }"
          :disabled="!editor.buffer"
          @click="editor.setBypass(false)"
        >
          B · 效果链
        </button>
        <button
          class="btn"
          :class="{ 'btn-primary': editor.chain.bypass }"
          :disabled="!editor.buffer"
          @click="editor.setBypass(true)"
        >
          A · 原声
        </button>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button
          class="btn"
          :disabled="!editor.buffer"
          title="按住时临时切回原始音频（不记录撤销）"
          @pointerdown="holdOriginal"
          @pointerup="releaseOriginal"
          @pointerleave="releaseOriginal"
          @pointercancel="releaseOriginal"
        >
          按住听原声
        </button>
        <button class="btn btn-primary" :disabled="!editor.buffer" @click="editor.audition()">
          {{ editor.isPlaying ? '停止试听' : '▶ 试听' }}
        </button>
      </div>
      <p class="text-[10px] text-slate-500 leading-relaxed">
        有选区时从选区起点试听；按 B 键可快速切换 A/B。参数改动立即生效，无需重新渲染。
      </p>
    </div>

    <!-- 作用范围 / 预设 -->
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="field-label">作用范围</label>
        <select class="field-input" :value="editor.chain.scope" @change="onScope">
          <option value="all">全曲</option>
          <option value="selection">仅选区</option>
        </select>
      </div>
      <div class="flex items-end pb-1">
        <p class="text-[11px]" :class="editor.chain.scope === 'selection' && !editor.hasSelection ? 'text-warn/80' : 'text-slate-500'">
          {{ scopeHint }}
        </p>
      </div>
    </div>

    <div>
      <label class="field-label">快速预设</label>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="(preset, i) in CHAIN_PRESETS"
          :key="preset.name"
          class="btn px-2 py-1"
          :title="preset.hint"
          @click="editor.applyPreset(i)"
        >
          {{ preset.name }}
        </button>
      </div>
    </div>

    <!-- 效果链节点 -->
    <div class="space-y-2">
      <div
        v-for="card in cards"
        :key="card.id"
        class="panel p-2.5 space-y-2"
        :class="{ 'opacity-50': !card.enabled }"
      >
        <div class="flex items-center gap-1.5">
          <input
            type="checkbox"
            :checked="card.enabled"
            :title="card.enabled ? '停用该效果' : '启用该效果'"
            @change="onEnabled(card.id, $event)"
          />
          <span class="font-mono text-[10px] text-slate-500 w-4 shrink-0">{{ card.index + 1 }}</span>
          <span class="text-xs text-slate-200 flex-1 truncate" :title="card.hint">{{ card.label }}</span>
          <span class="text-[9px] px-1 py-0.5 border border-neon/30 rounded text-neon/80 shrink-0">
            {{ card.short }}
          </span>
          <button
            class="btn px-1.5 py-0.5"
            :disabled="card.index === 0"
            title="上移（改变处理顺序）"
            @click="editor.moveEffect(card.id, -1)"
          >
            ↑
          </button>
          <button
            class="btn px-1.5 py-0.5"
            :disabled="card.index === cards.length - 1"
            title="下移（改变处理顺序）"
            @click="editor.moveEffect(card.id, 1)"
          >
            ↓
          </button>
          <button class="btn btn-danger px-1.5 py-0.5" title="移除" @click="editor.removeEffect(card.id)">
            ×
          </button>
        </div>

        <div v-for="spec in card.params" :key="spec.key" class="flex items-center gap-2">
          <span class="text-[10px] text-slate-500 w-12 shrink-0">{{ spec.label }}</span>
          <input
            class="neon-range flex-1"
            type="range"
            :min="spec.min"
            :max="spec.max"
            :step="spec.step"
            :value="spec.value"
            :disabled="!card.enabled"
            @input="onParam(card.id, spec.key, $event)"
          />
          <span class="font-mono text-[10px] text-neon w-14 text-right shrink-0">{{ fmt(spec) }}</span>
        </div>

        <p v-if="card.short === 'GATE'" class="text-[10px] text-slate-600 leading-snug">
          试听由 AudioWorklet 实时处理；导出与固化时按采样精确渲染。
        </p>
      </div>

      <p v-if="!cards.length" class="text-[11px] text-slate-500 leading-relaxed panel p-3">
        效果链为空。选择下方类型添加节点，或直接载入上方预设。节点按顺序依次处理，可随时停用、排序、改参数。
      </p>
    </div>

    <!-- 添加节点 -->
    <div class="flex gap-2">
      <select class="field-input flex-1" v-model="addKind">
        <option v-for="kind in EFFECT_KINDS" :key="kind" :value="kind">
          {{ EFFECT_META[kind].label }}
        </option>
      </select>
      <button class="btn btn-primary" @click="addEffect">＋ 添加</button>
    </div>

    <!-- 固化 / 清空 -->
    <div class="flex gap-2">
      <button
        class="btn flex-1 py-2"
        :disabled="!editor.chainActiveNow || busy || !editor.buffer"
        title="按当前参数把效果写入音轨，之后可继续叠加新效果"
        @click="editor.bounceChain()"
      >
        {{ editor.busy.type === 'effects' ? `渲染中 ${Math.round(editor.busy.progress)}%` : '写入音轨（固化效果）' }}
      </button>
      <button
        v-if="editor.busy.type === 'effects'"
        class="btn btn-danger px-3 py-2"
        @click="editor.cancelProcessing()"
      >
        取消
      </button>
    </div>
    <button class="btn btn-danger w-full" :disabled="!cards.length || busy" @click="editor.clearChain">
      清空效果链
    </button>

    <div v-if="editor.busy.type === 'effects'" class="h-1.5 rounded bg-abyss-800 overflow-hidden">
      <div
        class="h-full bg-neon shadow-glow transition-all"
        :style="{ width: `${editor.busy.progress}%` }"
      />
    </div>

    <p class="text-[11px] text-slate-600 leading-relaxed">
      效果链是非破坏性的：波形始终显示原始音频，只有播放试听与导出时才应用效果，
      导出前会按链顺序离线精确渲染。所有链改动（含参数拖动）均可 Ctrl+Z 撤销；
      工程文件会一并保存链状态。需要把效果变成可继续剪辑的数据时再用「写入音轨」。
    </p>
  </div>
</template>
