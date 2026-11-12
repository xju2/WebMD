import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  server: {
    host: '127.0.0.1',
    allowedHosts: ['crab.tail36e072.ts.net'],
    proxy: {
      '/api': process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3000'
    }
  },
  preview: {
    host: '127.0.0.1',
    allowedHosts: ['crab.tail36e072.ts.net']
  }
});
