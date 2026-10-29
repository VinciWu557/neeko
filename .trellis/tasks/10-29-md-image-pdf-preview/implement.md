# 执行计划：Markdown 图片渲染与 PDF 预览

> 需求见 `prd.md`，设计见 `design.md`。按 P1 → P2 → P3 顺序执行，每阶段独立提交、独立可回滚。
> TDD：每个检查项先写失败测试（Red）再实现（Green）再重构。

## P1 · 图片解析统一 + 渲染点接线（纯前端，修复 AC1/AC2）

- [x] 1.1 `src/shared/utils/localAsset.ts`：实现 `resolveAssetUrl(src, basePath?)`
      纯函数（通用 scheme 直通 + 绝对/相对路径解析）。
      测试（Red→Green）：data URI 在有 basePath 时不被改写；http(s)/blob/asset 直通；
      绝对路径 → convertFileSrc；相对路径拼 basePath；无 basePath 相对路径原样返回。
- [x] 1.2 抽 `src/ui/MarkdownImage.tsx`（原 `ImageBlock`），改用 `resolveAssetUrl`；
      `MarkdownPreview.tsx` 删除旧 `resolveImageSrc`。既有 MarkdownPreview 测试保持绿。
- [x] 1.3 `MessageContent.tsx`（agent-chat）接管 `img` → `MarkdownImage`，
      basePath 传项目工作目录。测试：相对路径图片解析出 convertFileSrc 结果。
- [x] 1.4 `MessageBlocks.tsx`、`PRDescription.tsx` 补传 basePath（项目根）。
- [x] 1.5 验证：`pnpm check:quick` 绿 + 手动确认本地项目 md 预览图片显示。
- **回滚点 A**：P1 独立提交（`fix(editor): unify markdown image resolution`）。

## P2 · 二进制流通道（range 语义）+ 远程图片（后端 + 前端，修复 AC3/AC5）

- [x] 2.1 `common/file/reader.rs`：`FileBytesRequest`（含 `offset`/`len`）+
      `read_file_bytes`（Local seek+read `spawn_blocking`；远程 `dd iflag=skip_bytes,count_bytes`
      + base64 decode）+ `read_file_size`（stat 通道）。
      Rust 单测（tempdir，红线 13）：整读 / range 读（offset+len）/ 越界 offset / 超单分片上界报错 /
      InProject 越界报错 / 空文件 / size 正确。
- [x] 2.2 `file/commands.rs`：`read_file_bytes` / `read_file_size` 薄命令（参数校验 + 调度）→
      `tauri::ipc::Response::new(Vec<u8>)`；注册 `lib.rs`；`fileApi.ts` 加包装器（invoke 只在 fileApi）。
- [x] 2.3 `src/shared/hooks/useAssetUrl.ts`：Local → convertFileSrc；
      远程 → `readFileBytes` 整读 → objectURL，cleanup revoke。
      测试：远程分支 mock invoke 得 blob URL；卸载 revoke；错误态。
- [x] 2.4 `MarkdownImage` / `ImageFileView` 接入 `useAssetUrl`；
      `useBinaryImagePreview.ts` 解除 `environmentType === 'Local'` 限制。
- [x] 2.5 验证：`pnpm check:quick` 绿；`cargo test --manifest-path src-tauri/Cargo.toml` 绿；
      远程项目（SSH/WSL）手动确认 md 图片与图片文件预览。
- **回滚点 B**：P2 独立提交（`feat(file): range-capable binary stream channel`）。

## P3 · PDF 预览（前端 + 依赖，修复 AC4/AC6）

- [x] 3.1 `package.json` + `pdfjs-dist`（唯一新依赖）；验证 vite worker 打包
      （`pdfjs-dist/build/pdf.worker.min.mjs?url`）。
- [x] 3.2 `shared/utils/fileTree.ts`：`isPdfFile`（纯函数测试）；
      `FileEditorFallback.tsx`：`fileEditorFallbackKind` 增 `'pdf'` 分支（测试覆盖分发顺序）。
- [x] 3.3 `pdf/PdfDataTransport`：实现 pdf.js `PDFDataRangeTransport`（length ← readFileSize，
      `requestDataRange` ← readFileBytes）；测试：range 请求→ invoke 参数正确、乱序/重叠请求不串数据。
- [x] 3.4 `PdfFileView.tsx`（TDD：先组件测试）：getDocument({ range: transport, disableAutoFetch: true })；
      **两种浏览模式**：连续滚动（默认，react-virtual 可视页渲染 + 离屏销毁）与单页翻页
      （上/下一页、页码、←/→）；缩放（适应宽度/百分比）；加载/错误态。
      mock 策略参照 `ImageFileView.test.tsx`；pdfjs 在测试中 mock（不跑真实解码）。
- [x] 3.5 大 PDF 验收（AC6）：构造/使用 ≥ 200MB PDF，确认按需拉分片（invoke 次数与可视页相关）、
      滚动浏览不卡死、内存不随滚动线性增长；损坏 PDF 错误态测试。
- [x] 3.6 验证：`pnpm check:quick` 绿；`pnpm tauri dev` 手动打开本地/远程 PDF（两种模式）；
      `pnpm tauri build` 后验证 pdf worker 资源路径（风险 1）。
- **回滚点 C**：P3 独立提交（`feat(editor): pdf preview with range loading`）。

## 收尾（Phase 2.2 / 3.3 / 3.4）

- [x] `pnpm check:quick` 全量确认（仅收尾跑一次）—— 33 条护栏全通过。
- [x] 对照 `prd.md` AC1–AC7 逐条勾验，补 `check.jsonl` 指定的 spec 检查。
      `cargo test --lib` 2260 passed（check:quick 不跑 Rust 测试，已单独补跑）。
      `npx vite build` 通过：pdf.js 为独立懒加载 chunk（436KB / gzip 131KB），
      worker 资源正确产出（`assets/pdf.worker.min-*.js`），设计风险 1 已消。
      AC6 大文件：机制由单测钉住（`disableAutoFetch` + range transport + 单分片 1MB 裁切），
      真机 ≥200MB 手动验收仍待用户在 `pnpm tauri dev` 下确认。
- [x] spec 更新：把「资源解析唯一入口 / 二进制读取通道」契约写入
      `.trellis/spec/frontend/api-layer.md` 与 `.trellis/spec/backend/command-guidelines.md`
      （或新增专题文件），供未来预览类型（音视频）复用。
- [x] `add_session.py` 记录会话；不主动提交代码（用户确认后提交）。

## 验证命令速查

```bash
pnpm check:quick                                   # 静态检查 + 改动文件单测（收尾一次）
cargo test --manifest-path src-tauri/Cargo.toml     # Rust 单测（改 .rs 后必须补跑）
pnpm test:fe                                        # 全量前端单测（push/CI 兜底，不主动跑）
```

## 追加修复（用户验收反馈）：worktree 路径基准

- [x] `FileEditorFallback`：图片预览改用「`tab.filePath`（Workspace 相对）+ `workspaceRootOf(tab.workspace.key, projectPath)`」，
      移除 `absFilePath` prop（它由 `sourceIdentityOf(projectPath, …)` 派生 ⇒ 指向主仓根）。
- [x] `ImageFileView`：props 从 `absPath` 改为 `filePath` + `basePath`，通道选择仍由 `useAssetUrl` 决定。
- [x] `useFileEditorState`：抽出 `editorBasePathOf(workspaceKey, projectPath, filePath)` 纯函数，
      md/html 预览基准改为工作树根（同类缺陷：worktree 里 md 相对图片会被拼到主仓根）。
- [x] 回归锁定：`FileEditorFallback.image.test.tsx`（worktree 断言指向工作树根）、
      `editorBasePath.test.ts`（5 用例含双根 bug 与反斜杠归一）、
      `ImageFileView.test.tsx`（worktree 基准 + 遮罩 + 失败兜底）。
- [x] `pnpm check:quick` 33/33 通过。

## 追加修复（第二次验收反馈）：图片仍加载失败 —— asset 协议 dotfile 403

- [x] **根因**（读 Tauri 源码定位，非前端路径问题）：`tauri.conf.json` 的
      `assetProtocol.scope` 用的是**简写数组**形态 `["**"]`。`FsScope` 简写形态没有
      `require_literal_leading_dot` 字段，Tauri 在 **Unix 上默认取 `true`**
      （`tauri/src/scope/fs.rs`：`// dotfiles are not supposed to be exposed by default on unix`）。
      `glob` 的 `**` 匹配到点开头路径段时立即判不匹配
      （`glob/src/lib.rs`：`follows_separator && require_literal_leading_dot && c == '.'`）。
      ⇒ `docs/.img/project-struct.png` 被 scope 拒绝 = asset 协议 **403** ⇒ `<img onError>`
      ⇒ “Image failed to load”（与 worktree / 相对路径无关，旧实现同样必然失败）。
- [x] 修复：`scope` 改为对象形态 `{ allow: ["**"], requireLiteralLeadingDot: false }`。
      **不**收紧为白名单（PRD 仍标为单独立项的加固项）。
- [x] 新护栏 `check_asset_protocol_dotfiles`（+ 9 条单测，已 Red 验证：改回简写数组即变红），
      防止回归到「碰运气」的简写形态。
- [x] 失败可见性：`ImageFileView` 失败态显示具体原因 + `console.warn`(filePath/basePath/src)，
      `MarkdownImage` 失败态加 `title`（此前只有文件名，排查只能靠猜）。
- [x] `pnpm check:quick` 34/34 通过。
