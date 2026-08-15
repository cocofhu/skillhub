# 参与贡献

感谢你帮助改进 skillhub。Bug 修复、API 兼容、测试、文档和交互优化都欢迎。

参与本仓库即表示你同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)，并以 [MIT License](LICENSE) 授权你的贡献。

本项目是非官方插件，不是 SkillHub 或 DeepSeek 的官方产品。

## 开始之前

1. 搜索现有 Issue 和 Pull Request，避免重复劳动。
2. 较大的功能或行为变更请先开 Issue 讨论方案。
3. 安全漏洞不要公开提交，请阅读 [SECURITY.md](SECURITY.md)。
4. 不要在 Issue、日志、测试夹具、截图或提交中包含密钥、Cookie、内网地址和个人数据。

## 本地开发

需要 Node.js 22+ 和 pnpm 11（与 `package.json` 的 `packageManager` 一致）。

```sh
git clone https://github.com/cocofhu/skillhub.git
cd skillhub
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

常用脚本：

| 命令 | 作用 |
| --- | --- |
| `pnpm typecheck` | TypeScript 检查，不写 `lib/` |
| `pnpm test` | 构建后跑 `node:test` |
| `pnpm build` | 清空并生成 `lib/`，复制 `src/client.js` |
| `pnpm pack:check` | 检查发布包文件列表 |

测试不访问真实网络，夹具放在 `src/tests/fixtures/`。

### 接入 Harness Web

```sh
dsh plugin --profile web add /absolute/path/to/skillhub
dsh web --host 127.0.0.1 --port 3080
```

请绑定 `127.0.0.1`，不要监听 `0.0.0.0`。

| 改动 | 如何生效 |
| --- | --- |
| `src/*.ts`（Host） | 重启 `dsh web` |
| `src/client.js`（Client） | `cp src/client.js lib/client.js` 后强制刷新浏览器 |

插件加载路径一般是 `~/.dsh/profiles/web/node_modules/skillhub`。若改的是 git clone 目录，确认 profile 安装的是同一路径。

## 代码约定

- Host 用 TypeScript；浏览器端保持无 JSX 的 `React.createElement`。
- 搜索只走 `GET /api/skills`，不要改用 `/api/v1/search`。
- 安装走 `GET /api/v1/download?slug=...&source=dsh` 的 zip；解压必须能读中央目录 / data descriptor。
- 上游请求必须有超时，并接受 `AbortSignal`。
- 安装必须拒绝路径穿越，且要求存在 `SKILL.md`。
- 不要把 `skillhub install`、curl 或 shell 安装命令写进对话正文。
- 修复解析或安装逻辑时，补不依赖实时网络的测试。
- 不提交 `lib/`、`node_modules/`、`.env`、日志、`skillhub.json` 或本地 skills。
- 不要把密钥、内网地址或真实用户数据放进夹具。

## 提交与 Pull Request

1. 从 `main` 开分支，例如 `fix/unzip-descriptor` 或 `docs/readme`。
2. 每个 PR 只做一件事，避免夹带无关重构。
3. 提交信息用简短祈使句，说明**为什么**改，例如 `Fix zip extract when local headers omit sizes`。
4. 推送前本地运行 `pnpm typecheck` 和 `pnpm test`。
5. 用 GitHub 的 PR 模板填写说明；UI 改动请附截图。
6. 关联 Issue 时写 `Closes #123`。

维护者会看：行为是否符合上述约定、测试是否覆盖、文档是否同步、CI 是否全绿。

## 持续集成

推送到 `main` 或打开 PR 时，GitHub Actions 会：

- 在 Node.js 22 和 24 上安装依赖、类型检查、跑测试
- 检查 `lib/` 未被提交
- 打包并确认 tarball 含 `LICENSE`、`lib/host.js`、`lib/client.js`，且不含 `src/` 与测试

依赖更新由 Dependabot 提交 PR。不必在文档 PR 里顺手升级无关依赖。

## 文档

用户能感知的行为变化请改 `README.md`。安全边界变化请改 `SECURITY.md`。发布说明写入 `CHANGELOG.md`。
