# Changelog

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- 插件市场安装改为 Host 按 install-plan 直装（`dsh plugin add`），不再排队 Agent 审核 prompt，也不依赖当前任务
- 安装过程展示按钮 loading 与阶段进度（Host 真实阶段 → 自动重启 → done）
- 直装成功后向当前 dsh 进程发送 SIGTERM 优雅退出；推荐在有 KeepAlive/supervisor 的环境使用，无守护时需自行拉起

### Security

- Host 直装前请求 `GET /api/v1/plugins/{owner}/{name}` 独立核验 `installability=verified`，忽略客户端伪造字段，不走搜索列表
- `install-plan` source 必须为 40 位 hex commit-pinned `github:owner/repo#sha`；拒绝 file/link/http(s)/绝对路径/短 SHA/浮动 ref；`plugin.headSha` 若存在必须与 pin 一致
- 直装默认仅允许 `https://api.skillhub.cn`；自定义需 `SKILLHUB_ALLOW_CUSTOM_API_BASE=1`；直装 fetch 使用 `redirect: error`

## [0.2.1] - 2026-08-18

### Changed

- 插件市场改到设置「插件」分区的标签页，不再单独占侧栏一项
- 市场只浏览已验证的 DSH 插件，筛选项改用 `/api/v1/plugins/categories` 的 7 个 Plugin 类目

### Fixed

- 客户端不再在未 inject `locale` 时读取 `ctx.locale`，避免 loader 报 `cannot get property "locale" without inject@skillhub`
- `settings.plugin.item` 按 keyed slot 用 `key` 注册，不再传 `id`，避免 loader 报 `requires options.key`
- Host 登记 `skillhub` settings 命名空间，插件配置页才能分发 SkillHub 卡片

## [0.2.0] - 2026-08-17

### Added

- 设置侧栏「SkillHub 市场」：搜索 / 筛选 SkillHub 收录的 DSH 插件，点「交给 DSH 安装」把审核安装提示词排入当前任务

## [0.1.1] - 2026-08-16

### Added

- 设置页「更新」按钮：安装 GitHub 最新 release，并提示重启 Harness

### Fixed

- API 与图标请求自动继承反向代理的子路径前缀，兼容轻量云等路径代理

## [0.1.0] - 2026-08-16

### Added

- DeepSeek Harness Web 插件：搜索、安装、列出、卸载 SkillHub 技能
- 对话内技能卡片与详情弹窗（概述 / 版本历史 / TRACE 评测）
- zip 安装（兼容 data descriptor / 中央目录）
- 设置页配置 API 地址、安装目录与搜索数量
- 中英文界面跟随 Harness 语言
- http / unzip / 安装安全、配置 overlay、搜索回退与 Host 渲染测试
- CI 核心模块覆盖率门槛，以及独立的打包检查 job
