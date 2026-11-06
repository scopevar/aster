# Aster CLI

本包采用 GNU GPL v3.0（`GPL-3.0-only`）。构建后的完整许可证见 `dist/licenses/LICENSE.txt`，第三方声明见 `dist/licenses/THIRD_PARTY_LICENSES.txt`，依赖自带的许可文件和索引保存在 `dist/licenses/third-party/`。

独立的执行 daemon 和命令行控制工具。需要 Node.js >=22.23.1；无需 Electron、Desktop 或图形窗口。此包暂不发布，只通过本地 tarball 安装。

在仓库根目录执行：

```powershell
pnpm install
pnpm pack:cli
npm install --global .runtime/cli-pack/aster-cli-0.0.1.tgz
aster --data-dir D:\aster-data start
aster --data-dir D:\aster-data status
aster --data-dir D:\aster-data stop
```

本地版不登录 Aster 账户，也不支持配对或远程控制。首次启动的旧数据选择使用 `workspace` 的 `status` / `select`；多个候选不自动合并。

`run` 在前台运行，`start` 启动后台进程或连接已有 daemon，退出 CLI 或 Desktop 不会停止它。只有显式 `stop` 才请求停止，并有界核验资源清理。不要同时复制、启动同一份主机数据。

`workspace`、`models`、`plugins`、`command` 和 `snapshot` 接收 stdin JSON；`aster help` 列出各入口。密码、模型凭据和插件秘密不要写在命令行参数或历史记录中。

沿用的交互式模型认证辅助程序在包内 `dist/scripts/model-auth.js`。使用时必须显式指定 `--home <daemon数据目录>/agent`，再提供 `--provider <提供商> --type api_key` 或 `--type oauth`；辅助程序同样强制安全存储，密钥从终端输入，不放进参数。OAuth 是否可用由提供商决定，独立包本轮不作真实提供商验收。

Windows 使用当前用户 DPAPI。Linux 安装 `secret-tool` 并提供可用的 Secret Service；系统密钥环保存包装密钥，磁盘只写认证加密后的密文。无密钥环的无图形主机可由受保护环境注入 `ASTER_CLOUD_SECRET_KEY`（64 位十六进制），需要保存原密钥以便恢复，不写明文密钥文件。

已有 Electron safeStorage 密文不会重置或自动迁移。兼容读取或显式 `migrate-secrets` 需要原保护上下文：可指定 `ASTER_ELECTRON_BIN` 和 `ASTER_ELECTRON_APP` 指向原安装程序/保护助手；这仅用于读取旧包装。明确停止 daemon 后执行 `aster --data-dir <目录> migrate-secrets`，将原 AES 密钥重新包装到 Windows 当前用户 DPAPI 或 Linux 系统密钥环，原 Bot、会话和凭据密文保持不变。迁移后无需 Electron。密钥环不可用、密钥丢失或包装损坏会拒绝操作并保留原文件。旧版本无法读取新包装，回退必须恢复迁移前的一致备份及原保护上下文。

包内包含执行核心、MCP 服务、文档解析线程、OCR 数据及 Microsandbox 脚本执行服务。原生模块由安装工具按目标 Node/系统安装。Desktop 使用同一包，并额外附带匹配的 Node；普通桌面用户无需另装 CLI 或系统 Node。不同系统的安装目录不可直接复制互换。
