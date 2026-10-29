import fs from 'fs';
import path from 'path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * pdf.js 运行时资源（CMap / 标准字体 / wasm）直出插件。
 *
 * 这些文件是 **pdf.js 的运行时数据**而不是应用代码：CJK 字体未嵌入的 PDF 需要 CMaps，
 * 标准 14 字体需要 standard_fonts，JPEG2000 图像需要 wasm。必须能从应用同源路径取到，
 * 否则 pdf.js 只能降级（缺字 / 报 "CMap is not available"）。
 *
 * 从 `node_modules/pdfjs-dist` **直出**（dev 用中间件、build 用 emitFile），不复制进仓库：
 * 复制会带来「版本升级后残留旧副本」与「忘了重跑复制脚本」两类静默失效。
 * 消费侧路径见 `src/features/editor/components/pdf/usePdfDocument.ts` 的
 * `PDFJS_ASSET_BASE` —— 两处必须一致。
 */
const PDFJS_ASSET_DIRS = ['cmaps', 'standard_fonts', 'wasm'] as const;
const PDFJS_ASSET_MOUNT = '/pdfjs/';

function pdfjsAssets(): Plugin {
  const root = path.resolve(__dirname, 'node_modules/pdfjs-dist');
  const fileFor = (url: string): string | null => {
    const clean = url.split('?')[0];
    if (!clean.startsWith(PDFJS_ASSET_MOUNT)) return null;
    const rel = clean.slice(PDFJS_ASSET_MOUNT.length);
    // 挂载点下只允许白名单目录，杜绝 `..` 穿越（静态文件服务是最容易被忽视的入口）
    if (!PDFJS_ASSET_DIRS.some((dir) => rel.startsWith(`${dir}/`))) return null;
    const full = path.resolve(root, rel);
    return full.startsWith(root) && fs.existsSync(full) && fs.statSync(full).isFile()
      ? full
      : null;
  };

  return {
    name: 'neeko:pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = req.url ? fileFor(req.url) : null;
        if (!file) return next();
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const dir of PDFJS_ASSET_DIRS) {
        const dirPath = path.join(root, dir);
        if (!fs.existsSync(dirPath)) continue;
        for (const name of fs.readdirSync(dirPath)) {
          const file = path.join(dirPath, name);
          if (!fs.statSync(file).isFile()) continue;
          this.emitFile({
            type: 'asset',
            fileName: `pdfjs/${dir}/${name}`,
            source: fs.readFileSync(file),
          });
        }
      }
    },
  };
}

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), pdfjsAssets()],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    // 单实例 @codemirror/view：lock 曾并存 6.43.9（经 lint/theme-one-dark 间接）
    // 与 6.43.11（直引），预打包产出双 view 实例导致 facet 失配、滚动后点击
    // 光标错位。dedupe 强制两处 import 收敛到同一副本（版本唯一性由
    // pnpm.overrides + check_codemirror_singleton.py 保障）。
    dedupe: ['@codemirror/view', '@codemirror/state'],
  },

  /**
   * 强制启动期预打包 xterm 系依赖（design D7.2 根治 "Importing a module
   * script failed."）：applyRenderer 走 `import('@xterm/addon-canvas' /
   * '@xterm/addon-webgl')` 动态导入。若不在 include 里，Vite 只在**首次发现**
   * 时才按需 optimize —— dev server 长时间运行后（.vite 缓存被清 / 依赖版本
   * 变更 / optimizer 状态失效），运行中重载页面触发动态导入会拿到 504
   * Outdated Optimize Dep，WebKit 表现即 "Importing a module script failed."，
   * 终端因此停在 DOM renderer（实测 2026-09-03）。include 声明后 dep
   * optimization 在 server 启动时确定性完成，与运行期发现时序彻底解耦。
   * @xterm/xterm 与 fit/unicode11 是静态导入本就会被扫到，一并显式声明保持
   * 同批 browserHash，避免两批 optimize 产物交错。
   */
  optimizeDeps: {
    include: [
      '@xterm/xterm',
      '@xterm/addon-fit',
      '@xterm/addon-unicode11',
      '@xterm/addon-canvas',
      '@xterm/addon-webgl',
    ],
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**', '**/.*/**'],
    },
  },
  build: {
    target: 'chrome110',
    cssMinify: true,
    rollupOptions: {
      output: {
        manualChunks: {
          xterm: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-unicode11'],
          highlight: ['highlight.js/lib/core'],
          lucide: ['lucide-react'],
          mermaid: ['mermaid'],
          codemirror: [
            '@codemirror/autocomplete',
            '@codemirror/commands',
            '@codemirror/language',
            '@codemirror/state',
            '@codemirror/view',
            '@lezer/highlight',
            '@uiw/codemirror-themes',
            '@uiw/react-codemirror',
          ],
        },
      },
    },
  },
}));
