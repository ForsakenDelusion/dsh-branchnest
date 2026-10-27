# 开发与贡献

需要 Node.js 22.18 或更高版本。原生运行检查需要 DeepSeek Harness Desktop 0.2.1-rc.3。

```sh
npm ci --legacy-peer-deps
npm run typecheck
npm test
npm run build
npm run check:package
```

`--legacy-peer-deps` 用于开发 checkout：DSH 的成组运行依赖由实际 Harness 提供，安装的开发依赖只用于编译；插件的 runtime 依赖声明在 `peerDependencies`。构建产物 `dist/` 由 `npm run build` 生成，不提交到仓库。

`npm run smoke` 使用 Desktop 内置 CLI（可用 `DSH_CLI=/path/to/dsh` 指定），在系统临时目录创建全新 profile，加载本地确定性测试模型，验证原生 session、分支、草稿、存储和本地 stdio MCP 工具调用，不使用真实模型账户，也不修改日常 Desktop profile。添加 `-- --keep` 可保留测试服务供界面检查。

保留测试服务后，`node scripts/ui-smoke.mjs` 验证跨项目导航、原会话返回、阅读页侧栏与拖动区域；`node scripts/questions-ui-smoke.mjs` 验证原生问答在画布和阅读页中的完整提交。两个脚本复用 `artifacts/smoke.json` 指向的临时测试服务，需要可用的 Playwright 和 Chromium。可用 `PLAYWRIGHT_MODULE` 指定已有 Playwright 模块入口，用 `PLAYWRIGHT_CHROMIUM` 指定浏览器可执行文件。结果写入本地 `artifacts/`；测试服务的授权链接不要用于公开反馈。

`node scripts/reader-ui-smoke.mjs` 独立验证真实阅读页组件在宽屏、窄屏和减少动画设置下的行为，无需运行 DSH。它额外需要 React DOM 18，可用 `READER_REACT_DOM` 指定已有的 `react-dom/client` 文件。此检查验证拖动区域的样式声明；窗口物理拖动需在未锁屏的桌面 Electron 环境中另行验证。

## 分支与版本

- 日常开发进入 `dev`；提交代码和本地试装不递增正式版本，也不创建 GitHub Release。
- `main` 保存稳定版本。准备更新时，将一批已验证的修改从 `dev` 合入 `main`，并一次性确定版本号和更新记录。
- 仅当 `main` 上的稳定版本号变化且检查通过时，才发布对应 tag、Release 和安装包；普通文档或依赖元数据修改只跑检查、不发版。
- 首次推送只公开源码，不自动创建 Release。需要首次安装包时，可从 `main` 手动运行 Release plugin 工作流；之后保持上述版本变化规则。
- 开发试装包使用 `npm run dev:pack` 生成：版本号为下一补丁号的 `<version>-dev.<构建号>`，用于区分正式包和本地安装缓存，不生成 GitHub Release，也不修改源码中的正式版本号。

## 仓库内容

源码、测试和构建配置随仓库维护；`dist/`、安装包、测试 profile、运行日志和内部研究记录保留在本地，不随仓库发布。产品截图只保留 README 和使用指南实际引用的当前界面，放在 `docs/assets/`，截图顺序由根目录的 `screenshots.json` 声明。

提交前请确认 `npm run typecheck`、`npm test`、`npm run check:package` 均通过。修改界面时请同步更新受影响的截图。
