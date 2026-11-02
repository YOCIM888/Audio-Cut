import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// 自定义域名 audio.yocim.top 根路径部署，base 固定为 '/'
export default defineConfig({
  base: '/',
  plugins: [vue(), tailwindcss()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500
  }
})
