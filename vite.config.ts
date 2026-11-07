import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// 自定义域名 audio.yocim.top 根路径部署，base 固定为 '/'
export default defineConfig({
  base: '/',
  plugins: [vue(), tailwindcss()],
  // @ffmpeg/ffmpeg 内部用 new URL('./worker.js', import.meta.url) 创建 Worker，
  // 预打包会破坏该相对路径，需排除在依赖优化之外
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util']
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500
  }
})
