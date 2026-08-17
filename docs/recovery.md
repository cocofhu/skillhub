# 失败页粗暴恢复：卸载全部第三方

## 前提（必读）

- **skillhub Host 必须仍为 ACTIVE**。截图里的 FAILED 列表可以含 `skillhub`（那是客户端 fiber）；若 Host 也 FAILED，失败页没有按钮、本插件 HTTP 端点不存在。
- 触发场景仅限 Web **Failed to load plugins**，且 Host 仍可响应。进程 hang / 崩溃时本路径不可达，没有看门狗。
- **Host 不可达时的 CLI 回退**（失败页会展示同一条）：

```sh
skillhub-recovery nuke-third-party --profile web
# 然后重启 dsh web 并强制刷新
```

本能力挂在 Harness shell 失败页，通过 Host 的 `webServer.tapIndex` 注入**检测脚本**（仅当页面出现 `Failed to load plugins` 才拉取 overlay），**不依赖**已 FAILED 的客户端插件 fiber，也不是在 `src/client.js` 里做 unload-all / 自杀重启。

本仓库只有 `skillhub` 插件仓，**不能**直接改上游 `deepseek-harness` 的 `packages/client/web`；恢复 UI 以 Host 注入的 `src/recovery/overlay.js` 落地，文案与状态机来自同目录 `fail-page-machine.ts`。

## 做什么

粗暴策略：**一次性移除当前 profile 的全部第三方插件**（含 anime-find、skillhub 等），保留基线 bundle（`@deepseek-ai/dsh-base` / `dsh-web-app` / `dsh-headless`）以及 patch 内的 `core` / `ui` / `settings` 等 fiber id。npm 依赖白名单**只**认基线 bundle 包名——包名恰好叫 `settings` 的第三方依赖会被卸掉。

实现上对齐 `dsh plugin remove`：改写 profile `package.json` + `cordis.patch.yml` 后执行 `pnpm remove` 并清理 `node_modules`；若存在 `$DSH_HOME/cordis.patch.yml` 也会剥掉第三方 insert。

成功标准：Host **先 detached 复用原 argv 拉起** `dsh web`（spawn 失败则 **不** `process.exit`，失败页可重试），成功后再退出当前进程；浏览器轮询到服务再强制刷新，进入正常 Web UI；第三方不再阻断引导。

## 失败页一键 Nuke

1. 打开 Web，看到 `Failed to load plugins`（列表可能含 anime-find、skillhub；常见文案含 `list slot "settings.plugin.item" requires options.id`）。
2. 检测脚本确认失败壳后才拉取 `/skillhub/recovery.js`。**健康 boot 即使手动/自动 GET 了 recovery.js 也不会武装 nonce**；`POST /skillhub/recovery/nuke` 恒 **404**。
3. 武装条件是 Host 可观测的 fail-loud：Host loader 已有 FAILED/无 fiber 的 entry，或失败页 overlay 调用 `POST /skillhub/recovery/arm`（`failLoud: true`）拿到一次性 nonce。
4. 点主按钮 **快速修复 · 卸载全部第三方**（请求体带 `confirm` + `nonce`）。
5. 成功后提示安全模式；Host 会 **先 spawn 原进程 argv（detached）再退出当前进程**。spawn 失败返回 500，不退出、nonce 仍可用，可重试。

恢复 HTTP 端点仅接受本机 socket peer（忽略 `X-Forwarded-For`）；Host 名仅认解析后的 loopback IP / `localhost`（`127.attacker.example` 会被拒绝）。

## CLI 等价命令

```sh
pnpm recovery nuke-third-party --profile web --dry-run
pnpm recovery nuke-third-party --profile web
```

发布包提供 `skillhub-recovery` 可执行文件。Host 不可达、按钮缺失、或 overlay 报未武装时，用这一条，不要依赖页内按钮。

## 显式非目标

- 在 skillhub 等第三方**客户端插件**内自救或 unload-all
- 卸载基线 bundle / 基线 fiber id
- 进程 hang / 崩溃后的自动恢复（无进程管理器时仍依赖本次 detached respawn；若 spawn 失败需人工再起或点重试）
- 细粒度只删肇事项
- 把 Web 引导从 fail-loud 改成部分加载仍进正式 UI
- 伪装改了上游 `packages/client/web`（本仓做不到；中期应把 overlay/nuke 迁到 Harness shell）
