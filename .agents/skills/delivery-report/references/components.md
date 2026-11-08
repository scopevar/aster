# 数据与组件约定

以 `assets/example.json` 为可运行示例。生成器拒绝未知字段，避免内容被静默忽略。所有正文值为字符串，按纯文本显示；需要链接时使用 `link` 或 `cards`。

## 报告与章节

```json
{
  "version": 1,
  "title": "任务交付报告",
  "status": "待验收",
  "subtitle": "版本或重要背景",
  "pages": [
    {
      "id": "overview",
      "title": "交付概览",
      "group": "任务与实现",
      "description": "本章的简短结论",
      "sections": [
        {
          "id": "overview-summary",
          "title": "本次交付",
          "blocks": [{ "type": "paragraph", "text": "填写实际改动。" }]
        }
      ]
    }
  ]
}
```

根对象的 `subtitle`、`status` 可省略；章节的 `group`、`description` 可省略。相邻同组章节归在同一个目录分组下。章节、小节和内容块列表不能为空；章节数与标题可调整，不要求固定六章。

所有章节与小节的 `id` 全局唯一，以小写字母开头，仅包含小写字母、数字和连字符。章节链接为 `#/overview`，小节链接为 `#overview-summary`，可跨章节跳转。一般链接支持 HTTPS、HTTP、mailto 和相对附件路径；路径空格须 URL 编码，不支持脚本或任意 data 链接。

## 内容块

| type        | 必填字段            | 可选字段与规则                                                 | 展示组件              |
| ----------- | ------------------- | -------------------------------------------------------------- | --------------------- |
| `paragraph` | `text`              | 无                                                             | 正文段落              |
| `list`      | `items`：字符串数组 | `ordered`：布尔值，默认无序                                    | 列表                  |
| `table`     | `columns`、`rows`   | 表头字符串数组；每行字符串数组，长度等于表头数                 | Fumadocs Table        |
| `code`      | `code`              | `title`；保留原始换行，可复制；不进行语言高亮                  | CodeBlock、Pre        |
| `callout`   | `text`              | `title`、`tone`；tone 为 info、warn、error、success，默认 info | Callout               |
| `details`   | `title`、`blocks`   | 折叠显示子内容块                                               | Accordions、Accordion |
| `steps`     | `items`：对象数组   | 每项必填 `title`、`text`                                       | Steps、Step           |
| `cards`     | `items`：对象数组   | 每项必填 `title`、`href`，可选 `description`                   | Cards、Card           |
| `tabs`      | `items`：对象数组   | 每项必填 `title`、`blocks`                                     | Tabs、Tab             |
| `link`      | `text`、`href`      | 无                                                             | Fumadocs Link         |
| `image`     | `src`、`alt`        | `caption`；src 为内嵌 PNG/JPEG/GIF/WebP 的 base64 data URL     | ImageZoom             |

除表格数据行可为空外，上述列表均须至少一项。嵌套内容最多 12 层。以报告阅读需要为准，不必使用所有组件。

## 折叠实际命令与日志

```json
{
  "type": "details",
  "title": "查看验证命令与输出",
  "blocks": [
    {
      "type": "code",
      "title": "实际命令与输出",
      "code": "在这里粘贴真实命令和输出；未执行时明确说明。"
    }
  ]
}
```

摘要表写结论、范围和缺口，折叠块保留必要原始证据。不要在各章重复整段日志。
