<script setup lang="ts">
/** 音频修复：噪声指纹降噪、去咔嗒、真峰值限制器、独立变调 */
import { computed, ref } from 'vue'
import { useEditorStore } from '../stores/editor'
import { NOISE_BANDS } from '../audio/spectral'

const editor = useEditorStore()

const amountDb = ref(12)
const sensitivity = ref(0.55)
const ceiling = ref(-1)
const semitones = ref(0)
const scope = ref<'selection' | 'all'>('all')

const busy = computed(() => editor.busy.type !== null)
const onlySelection = computed(() => scope.value === 'selection' && editor.hasSelection)
const scopeHint = computed(() =>
  scope.value === 'selection' && !editor.hasSelection ? '（未框选，按全曲处理）' : ''
)
const profileBars = computed(() => {
  const p = editor.noiseProfile
  if (!p) return []
  return p.bands.map((db) => Math.max(0, Math.min(1, (db + 100) / 90)))
})

function cancel(): void {
  editor.cancelProcessing()
}
</script>

<template>
  <div class="space-y-3">
    <!-- 作用范围 -->
    <div class="panel p-3 space-y-1.5">
      <label class="field-label">作用范围</label>
      <div class="flex gap-3 text-xs text-slate-300">
        <label class="flex items-center gap-1.5 cursor-pointer">
          <input type="radio" value="all" v-model="scope" /> 全曲
        </label>
        <label class="flex items-center gap-1.5 cursor-pointer" :class="{ 'opacity-40': !editor.hasSelection }">
          <input type="radio" value="selection" v-model="scope" :disabled="!editor.hasSelection" /> 仅选区
        </label>
      </div>
      <p v-if="scopeHint" class="text-[10px] text-warn/80">{{ scopeHint }}</p>
    </div>

    <!-- 噪声指纹 -->
    <div class="panel p-3 space-y-2">
      <div class="flex items-center justify-between">
        <label class="field-label !mb-0">噪声指纹降噪</label>
        <span class="text-[9px] text-slate-600">谱减法 · {{ NOISE_BANDS }} 段</span>
      </div>
      <p class="text-[10px] text-slate-500 leading-relaxed">
        先框选一段「只有底噪、没有语音」的片段，采样其频谱作为噪声指纹，再对整个音轨做功率谱减。
      </p>
      <button class="btn w-full" :disabled="!editor.buffer || busy" @click="editor.captureNoise()">
        {{ editor.hasSelection ? `采样当前选区 ${(editor.selection.end - editor.selection.start).toFixed(2)}s` : '采样开头 0.5s' }}
      </button>
      <div v-if="editor.noiseProfile" class="flex items-end gap-[2px] h-8 px-1 bg-abyss-800/60 rounded">
        <div
          v-for="(v, i) in profileBars"
          :key="i"
          class="flex-1 bg-neon/70 rounded-t-sm"
          :style="{ height: `${Math.max(4, v * 100)}%` }"
        />
      </div>
      <div>
        <span class="text-[10px] text-slate-500">降噪强度 {{ amountDb }} dB</span>
        <input class="neon-range w-full" type="range" min="0" max="30" step="1" v-model.number="amountDb" />
      </div>
      <button class="btn btn-primary w-full" :disabled="!editor.buffer || busy || !editor.noiseProfile" @click="editor.applyDenoise(amountDb, onlySelection)">
        应用谱减降噪
      </button>
    </div>

    <!-- 去咔嗒 -->
    <div class="panel p-3 space-y-2">
      <label class="field-label">去咔嗒 / 去爆音</label>
      <p class="text-[10px] text-slate-500 leading-relaxed">
        用二阶线性预测误差定位脉冲式跳变，按相邻干净采样线性插值修复；所有声道共用命中掩码，不破坏立体声相位。
      </p>
      <div>
        <span class="text-[10px] text-slate-500">灵敏度 {{ sensitivity.toFixed(2) }}（越高越容易误伤瞬态）</span>
        <input class="neon-range w-full" type="range" min="0" max="1" step="0.05" v-model.number="sensitivity" />
      </div>
      <button class="btn w-full" :disabled="!editor.buffer || busy" @click="editor.applyDeclick(sensitivity, onlySelection)">
        检测并修复咔嗒
      </button>
    </div>

    <!-- 限制器 -->
    <div class="panel p-3 space-y-2">
      <label class="field-label">前瞻真峰值限制器 + 抖动</label>
      <p class="text-[10px] text-slate-500 leading-relaxed">
        5ms 前瞻滑动峰值、1ms 启动 / 50ms 释放，最后用 4x 插值真峰值复测并校正，保证不超上限。
        16/24-bit 导出的 TPDF 抖动在「导出」面板单独设置。
      </p>
      <div class="flex items-center gap-2">
        <select class="field-input flex-1" v-model.number="ceiling">
          <option :value="-1">-1 dBTP</option>
          <option :value="-2">-2 dBTP</option>
          <option :value="-3">-3 dBTP</option>
          <option :value="-6">-6 dBTP</option>
        </select>
        <button class="btn btn-primary flex-1" :disabled="!editor.buffer || busy" @click="editor.applyLimiter(ceiling, onlySelection)">
          应用限制器
        </button>
      </div>
    </div>

    <!-- 独立变调 -->
    <div class="panel p-3 space-y-2">
      <label class="field-label">独立变调（时长不变）</label>
      <p class="text-[10px] text-slate-500 leading-relaxed">
        WSOLA 先按 1/p 拉长且保持音调，再以 p 倍速重采样回原长 —— 只改音调，不改成「花栗鼠」也不拖慢语速。
      </p>
      <div class="flex items-center gap-2">
        <input class="neon-range flex-1" type="range" min="-12" max="12" step="0.5" v-model.number="semitones" />
        <span class="font-mono text-neon w-14 text-right text-xs">{{ semitones > 0 ? '+' : '' }}{{ semitones.toFixed(1) }} st</span>
      </div>
      <div class="flex flex-wrap gap-1.5">
        <button v-for="p in [-12, -7, -5, 0, 5, 7, 12]" :key="p" class="btn px-2 py-0.5 text-[10px]" @click="semitones = p">{{ p > 0 ? '+' : '' }}{{ p }}</button>
      </div>
      <button class="btn btn-primary w-full" :disabled="!editor.buffer || busy || Math.abs(semitones) < 0.01" @click="editor.pitchShiftSemitones(semitones, onlySelection)">
        应用变调
      </button>
    </div>

    <!-- 进度与取消 -->
    <div v-if="editor.busy.type === 'repair' || editor.busy.type === 'analyze'" class="panel p-3 space-y-2">
      <div class="flex items-center justify-between text-[11px]">
        <span class="text-neon-bright">{{ editor.busy.type === 'analyze' ? '分析中' : '处理中' }} {{ Math.round(editor.busy.progress) }}%</span>
        <button class="btn btn-danger px-2 py-0.5 text-[10px]" @click="cancel">取消</button>
      </div>
      <div class="h-1.5 rounded bg-abyss-800 overflow-hidden">
        <div class="h-full bg-neon shadow-glow transition-all" :style="{ width: `${editor.busy.progress}%` }" />
      </div>
    </div>

    <p class="text-[10px] text-slate-600 leading-relaxed">
      以上操作均写入音轨（可 Ctrl+Z 撤销），与「效果链」的非破坏性试听互补。长音频在 Worker 中处理，界面不会假死。
    </p>
  </div>
</template>
