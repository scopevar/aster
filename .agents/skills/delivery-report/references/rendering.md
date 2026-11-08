# 填写与生成

需要 Python 3.10 或更新版本，仅使用标准库。可将整个 `delivery-report` 目录复制到任意项目或独立目录使用。

## 三个文件

- `assets/report-template.html`：可直接打开的单文件模板，内嵌官方组件、样式、Geist 字体与许可证；中文使用系统字体。
- `assets/example.json`：六章内容示例，全部标为待填写，不包含虚构通过结果。
- `scripts/render.py`：校验数据并填入模板，输出同样可离线打开的单文件 HTML。

## 日常使用

复制示例 JSON 到任务输出位置。按照 [数据约定](components.md) 填写事实；路径由当前任务决定，不要求特定项目目录、Git 或技术栈。

```sh
python /path/to/delivery-report/scripts/render.py ./report.json ./report.html
```

Windows 路径有空格时加引号。文件编码为 UTF-8。默认拒绝覆盖已有输出；确认更新的是本任务报告后加 `--force`。即使加此选项也不能覆盖输入 JSON 或模板。

生成器检查字段、组件类型、标识符、链接与表格列数。错误时说明数据位置，不输出假成功。正文是纯文本，不解释 Markdown 或原始 HTML；代码中的换行和标签原样显示。

输出无需本地服务。直接打开 HTML，核对章节导航、相关折叠项、代码复制、表格、深浅主题和窄窗口。模板导航以 `#/章节id` 和 `#小节id` 工作，不要手写站点路由。

## 图片与附件

图片用 PNG、JPEG、GIF 或 WebP 的 base64 data URL，以保证 HTML 离线可携带。用标准库转换已有真实截图：

```python
import base64
from pathlib import Path

src = "data:image/png;base64," + base64.b64encode(Path("screenshot.png").read_bytes()).decode("ascii")
```

填入 `image.src`，并提供描述性的 `alt` 和必要的 `caption`。不要把模板演示图当成实际界面证据。视频、日志等大附件用 `link` 引用，随报告交付；移动报告后相对路径须仍能访问。外部链接需要网络，不属于内嵌资源。

## 维护模板

日常报告仅改 JSON。模板的 `report-renderer` 脚本是可读的普通 JavaScript，将数据映射到已内嵌的官方组件；`report-vendor` 与 `report-styles` 是固定资源。需要更改内容类型时，同时更新渲染器、生成器校验和数据指南，再验证示例及真实浏览器行为。

当前资源来自 `@fumadocs/base-ui`、`fumadocs-core` 16.18.1，使用 Spacious 布局与 Neutral 主题；上游地址与已查看的提交在 HTML 开头。保留 `third-party-notices`。常规生成不下载或重新编译依赖；升级内嵌组件属于单独的模板维护任务。
