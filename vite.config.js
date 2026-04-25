import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [react(), VitePWA({ registerType: 'autoUpdate', manifest: { name: 'The Daily Food', short_name: 'Food', theme_color: '#2AA89A', background_color: '#1a0d2e', display: 'standalone', start_url: '/thedailyfood/', scope: '/thedailyfood/', icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }] } })],
  base: '/thedailyfood/',
})
