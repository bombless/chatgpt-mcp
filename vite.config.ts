import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
const root = process.cwd();
export default defineConfig({ root: resolve(root, 'src/server'), plugins: [vue()], base: '/', build: { outDir: resolve(root, 'dist/server/admin-ui'), emptyOutDir: true, rollupOptions: { input: resolve(root, 'src/server/admin.html') } } });
