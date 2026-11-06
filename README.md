# Aster · 本地桌面 AI 助手

面向 Windows 和 Linux 的本地 AI 助手。接入自己的模型 API Key 或本地模型，创建 Bot、聊天并使用工具。

## 主要功能

- **聊天与协作**：单聊、群聊、多 Bot 协作、流式回复、消息搜索与附件。
- **文件与工具**：文档、表格、OCR、视频、授权目录和隔离脚本执行。
- **技能与记忆**：Bot 技能、独立记忆、共享记忆、本地模板与 MCP 插件。
- **后台任务**：定时、周期和本机 Webhook 任务，支持数据库备份与恢复。

## 安装与开始使用

在 [Releases](https://github.com/scopevar/aster/releases) 查看 Windows 安装包、Linux AppImage 和 deb。安装包自带所需运行时。Linux 需要系统密钥环与 `secret-tool`，请在普通用户图形会话中运行。源码运行见[开发说明](docs/development.md)。

1. 打开 **应用菜单 → 设置 → 模型与连接**，添加模型供应商。
2. 填写 API Key，或连接本地 OpenAI 兼容服务，检查并保存配置。
3. 创建 Bot，选择供应商，开始聊天。

关闭窗口后，后台任务仍会继续运行；需要停止时，从托盘选择 **停止 daemon 并关闭**。

## 许可证

Copyright (c) 2026 scopevar。Aster 采用 [GNU GPL v3.0](LICENSE)（`GPL-3.0-only`）。

第三方组件按各自许可证分发，补充声明见 [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)。构建会保留依赖自带的许可文件并汇总为随包声明，可在 **设置 → 应用信息 → 第三方许可** 查看全文。
