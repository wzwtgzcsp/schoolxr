import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true  // 允许局域网设备（手机）访问
  }
});