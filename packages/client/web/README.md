# packages/client/web

Harness Web shell 失败页（`AppRoot` Loading/Failed）的恢复 UI 贡献面。

本仓库是 skillhub 插件，不能直接改上游 `deepseek-ai/deepseek-harness` 的 `packages/client/web/src/AppRoot.tsx`。实现落在：

- 状态机与文案：[`../../src/recovery/fail-page-machine.ts`](../../src/recovery/fail-page-machine.ts)
- 失败页按钮/执行态/安全模式提示：[`../../src/recovery/overlay.js`](../../src/recovery/overlay.js)

Host 通过 `webServer.tapIndex` 把 overlay 注入 index.html。脚本只在 DOM 出现 `Failed to load plugins` 时挂载，不依赖 FAILED 客户端 fiber。
