# 发布

通过 GitHub Actions 的 **Build and release** 工作流构建 Windows x64 安装包、Linux x64 AppImage 和 deb，发布到当前仓库的 GitHub Releases。

本地执行 `pnpm release` 只显示操作指引；`--ci` 参数供工作流调用。

## 发布前配置

- 启用 GitHub Actions。Nightly 和 Stable 发布要求仓库公开，私有仓库可运行 Preview。
- 配置 `production` environment，允许从 `main` 部署。
- 标签规则需允许发布任务创建版本标签。Stable 的版本号同步通过 PR，不要求发布任务绕过 `main` 保护。
- 在 Actions 的 Workflow permissions 中允许 GitHub Actions 创建 PR。工作流使用 GitHub 自动提供的 `GITHUB_TOKEN`，无需另配发布密钥；机器人创建的 PR 可能显示 **Approve workflows to run**，需有写权限的人批准 CI 运行，再按正常检查与验收流程合并。

## 如何发布

打开 **Actions → Build and release → Run workflow**，选择 `main` 分支和 `channel`：

- **preview**：检查并打包，从本次运行的 Artifacts 下载产物，不创建 Release。
- **nightly**：发布预览版本。版本号自动取最新正式版本的下一个补丁号，加日期和运行编号。
- **stable**：发布正式版本。`nightly_version` 填当前仓库中已安装、测试过的完整 Nightly 版本号；`version` 留空使用其基础版本，也可填写更高的正式 `X.Y.Z`，最终版本须高于已发布的正式版本。

Stable 使用所选 Nightly 的源码重新构建并检查，通过后发布并创建版本号同步 PR。`sync-version` 只准备 `package.json` 差异，不提交或推送 `main`；工作流将差异推到 `release/version-<版本>` 并创建 PR。重复运行复用已有未关闭 PR，未生成差异时跳过。版本 PR 通过检查并验收后 Squash 合并，发布已经完成，不因版本 PR 未合并而重新发布同一版本。

普通 PR 仅由独立的 **PR checks** 检查双平台完整入口与桌面 smoke，不默认打包；合并或普通推送 `main` 不触发新的检查或发布。需要安装验证时手动运行 `preview`。定时 Nightly 与手动发布仍检查实际发布源码，这些发布检查不属于合并后的重复 PR CI。

Nightly 每天北京时间 08:00（UTC 00:00）自动检查 `main`，GitHub Actions 调度可能延迟。首次运行会发布；之后仅在相较上次 Nightly 有应用或构建相关改动时发布，纯文档和测试改动会跳过，后续检查和打包任务也不运行。手动选择 `nightly` 不受改动检查限制，可随时构建发布。

发布前验证安装和升级。覆盖现有安装前，先[显式停止对应后台](development.md#后台启停)。Nightly 与 Stable 共用数据目录，不支持并排安装或自动降级。当前 Windows 安装包未签名。

## 第三方许可与源码

构建会保留依赖自带的许可文件，并将其与根目录 [THIRD_PARTY_LICENSES.txt](../THIRD_PARTY_LICENSES.txt) 的补充声明汇总，随 CLI 和桌面安装包携带。升级相关依赖时核对补充声明中的版本、原始许可和来源，并重新构建。

分发二进制前还需核对原生组件的对应源码：当前 microsandbox 0.7.11 固定的 libkrunfw 提交为 `70ff1e821a7b513adb391aef6ad538f6ce148c17`，其 Makefile 使用 Linux 6.12.113；sharp 的原生库版本以实际平台包中的 `versions.json` 为准。按适用许可证提供与该二进制匹配的源码、补丁和构建资料，例如在同一 Release 附上源码归档及获取说明。当前 CI 不自动准备这些源码归档；第三方组件保留各自许可证，文本和来源见 `THIRD_PARTY_LICENSES.txt`。

## 失败后重试

- 检查或构建失败：修复问题后重跑；源码有改动时发起新的运行。
- 上传或公开 Release 失败：在原运行选择 **Re-run failed jobs**，复用已有产物与草稿，不重新构建同一版本。
- Stable 已发布但 `sync_version` 失败：只重跑版本同步任务，不重发版本。若版本分支已存在但 PR 未创建，重试会复用分支创建 PR；若该分支被人工修改，先检查差异，不覆盖或强推。机器人 PR 等待 CI 运行批准时，在 PR 页批准后继续。

Artifacts 保留 7 天，过期后无法按原运行续传。保留已公开的版本标签和附件，不覆盖或删除后重新发布同一版本。
