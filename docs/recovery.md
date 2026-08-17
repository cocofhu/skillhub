# 失败页粗暴恢复：卸载全部第三方

触发场景仅限 Web 出现 **Failed to load plugins**，且 Host（`dsh web`）仍能响应。本能力挂在 Harness **shell 失败页**（AppRoot Loading/Failed），通过 Host 的 `webServer.tapIndex` 注入恢复 UI，**不依赖**已 FAILED 的客户端插件 fiber，也不是在 `src/client.js` 里做 unload-all / 自杀重启。

进程 hang 或崩溃时本路径不可达，没有看门狗。

## 做什么

粗暴策略：**一次性移除当前 profile 的全部第三方插件**（含 anime-find、skillhub 等），保留 `core` / `ui` / `settings` 以及 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 等基线层。不是只删单个肇事插件，也**禁止**把 unload-all（含基线）当作默认策略。

成功标准：重启 `dsh web` 并强制刷新后进入正常 Web UI；第三方不再阻断引导。第三方功能全部清掉，需事后按需重装。

## 失败页一键 Nuke

1. 打开 Web，看到 `Failed to load plugins`（列表可能含 anime-find、skillhub）。
2. 点主按钮 **快速修复 · 卸载全部第三方**。
3. 页面展示批量 remove 日志。成功后提示安全模式，Host 会退出当前进程以便重启；若没有进程管理器，请在终端重新运行 `dsh web`（绑定 `127.0.0.1`，加上预览外部 Host 时的 `--trusted-host`），然后强制刷新。

恢复 HTTP 端点仅接受本机 / 受信来源；非本机或未授权请求返回 403。

## CLI 等价命令

同一套原语，不经过浏览器：

```sh
# 先看将要移除的包
pnpm recovery nuke-third-party --profile web --dry-run

# 写入 profile（dependencies + bundles + cordis.patch.yml）
pnpm recovery nuke-third-party --profile web
```

发布包提供 `skillhub-recovery` 可执行文件，语义对齐 `dsh recovery nuke-third-party --profile <name>`。

然后：

```sh
dsh web --host 127.0.0.1 --port 3080
```

需要预览外部 Host 时追加 `--trusted-host <authority>`。不要使用 `--host 0.0.0.0`。

## 显式非目标

- 在 skillhub 等第三方**客户端插件**内自救或 unload-all
- 卸载基线（core / ui / settings / `@deepseek-ai/dsh-*` 模板层）
- 进程 hang / 崩溃后的自动恢复
- 细粒度只删肇事项（与 Demo 粗暴策略区分）
- 把 Web 引导从 fail-loud 改成部分加载仍进正式 UI
