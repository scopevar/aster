# 开发

## 环境准备

开发与 CI 统一使用 [.nvmrc](../.nvmrc) 中的 Node.js 版本，pnpm 版本以 [package.json](../package.json) 的 `packageManager` 为准。工作区、分支和提交约定见 [AGENTS.md](../AGENTS.md)。切换到指定版本后，在当前工作区根目录安装依赖：

```sh
pnpm install --frozen-lockfile
```

Linux 桌面需要可用的系统密钥环与 `secret-tool`。可选环境变量见 [.env.example](../.env.example)，启动无需创建 `.env`。

## 启动

为当前工作区显式设置独立数据目录，避免连接到其他实例。

PowerShell：

```powershell
$env:ASTER_DATA_DIR = Join-Path (Get-Location).Path '.runtime/agent-app'
pnpm dev
```

Linux shell：

```sh
export ASTER_DATA_DIR="$PWD/.runtime/agent-app"
pnpm dev
```

开发端口由 electron-vite 自动选择。启动异常时运行 `pnpm dev --doctor`，按输出检查依赖和后台状态。

## 后台启停

`pnpm dev` 复用同一数据目录的 daemon，没有时启动。关闭窗口或退出控制端不会停止后台；修改后台代码后，需要先停止对应实例，再运行 `pnpm dev`。

从托盘选择“停止 daemon 并关闭”，或在仓库根目录执行：

```sh
pnpm daemon --data-dir <数据根目录> status
pnpm daemon --data-dir <数据根目录> stop
```

只停止本任务创建的后台，等待资源清理完成。身份或停止结果无法确认时保留现场，不删除锁或数据目录来绕过问题。

## 构建与验证

- `pnpm build`：构建应用。
- `pnpm check`：类型、静态检查和核心测试；不包含环境测试或 Electron E2E。
- UI、系统能力及环境相关验证按 [AGENTS.md](../AGENTS.md#检查) 和[测试规则](../tests/AGENTS.md)选择。

开发启动、核心测试和 Playwright 的 `desktop` 项目会在运行前自动准备缺失的 Electron 程序，已有程序直接复用；下载失败时停止，不进入启动或测试。独立 Renderer 测试不触发安装，`pnpm dev --doctor` 仍然只读。直接运行依赖 Electron 的单个 Node 测试前，可执行 `node scripts/prepare-electron.mjs`。

脚本环境需要 Windows WHP 或 Linux glibc/KVM，安装依赖时保留 optional dependencies。验证真实 VM 前先构建，再在具备虚拟化能力的宿主执行：

```powershell
$env:ASTER_TEST_MICROSANDBOX = '1'
node --import tsx --test tests/microsandbox.test.ts
pnpm exec playwright test tests/e2e/scripts.spec.ts --project=desktop
```

## 相关入口

- 界面：[Renderer](../src/ui/)、[图标组件](../src/ui/components/icons.tsx)、[开发构建配置](../electron.vite.config.ts)。
- 桌面：[Main](../src/desktop/main.ts)、[Preload](../src/desktop/preload.ts)；IPC 处理、系统能力、窗口、更新、后台连接和进程管理分别位于 `src/desktop/` 的对应子目录。
- 存储：[Store](../src/storage/store.ts) 与装配入口留在模块根目录，命令、迁移、备份及各业务的持久化实现按职责分目录。
- 共享契约：[IPC](../src/shared/ipc-contracts.ts) 与 [Worker 路由](../src/shared/protocol.ts) 留在模块根目录，会话、文件、工具、模板和桌面相关契约分别位于对应子目录。
- [CLI 使用与凭据迁移](../packages/cli/README.md)。
- [发布流程](releasing.md)。
