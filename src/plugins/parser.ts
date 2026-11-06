import { pluginUrl } from "./connection.js";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AppError } from "../shared/core.js";
import {
  pluginContentSchema,
  pluginMcpSchema,
  type PluginContent,
} from "../shared/tools/plugins.js";

const paths = [
  ".cursor-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  "plugin.json",
];
const pathList = z.union([z.string(), z.array(z.string()).max(100)]);
const manifestSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(""),
  version: z.string().max(80).default(""),
  skills: pathList.optional(),
  commands: pathList.optional(),
  rules: pathList.optional(),
  agents: z.unknown().optional(),
  hooks: z.unknown().optional(),
  mcpServers: z.unknown().optional(),
  variables: z.unknown().optional(),
});

export function parsePlugin(files: Record<string, string>): PluginContent {
  const read = (path: string) => {
    const data = files[path.replace(/^\.\//, "")];
    if (data === undefined)
      throw new AppError("invalid_input", `插件文件不存在：${path}`);
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > 128 * 1024)
      throw new AppError("capacity", "插件配置或技能超过 128 KiB。");
    return bytes.toString("utf8");
  };
  const selected = paths.find((path) => files[path] !== undefined);
  if (!selected)
    throw new AppError(
      "invalid_input",
      "目录中缺少 .cursor-plugin/plugin.json 或 .claude-plugin/plugin.json。",
    );
  const manifest = manifestSchema.parse(JSON.parse(read(selected)));
  const skills: PluginContent["skills"] = [],
    warnings: string[] = [];
  const collect = (kind: "skills" | "commands" | "rules") => {
    const configured = manifest[kind],
      defaults =
        kind === "skills"
          ? ["skills", ...(files["SKILL.md"] ? ["SKILL.md"] : [])]
          : [kind];
    for (const raw of configured === undefined
      ? defaults
      : typeof configured === "string"
        ? [configured]
        : configured) {
      const prefix = raw.replace(/^\.\//, "").replace(/\/$/, "");
      if (
        prefix.includes("..") ||
        prefix.startsWith("/") ||
        prefix.includes("\\")
      )
        throw new AppError("invalid_input", "插件组件路径无效。");
      const matches = Object.keys(files)
        .filter((path) => path === prefix || path.startsWith(`${prefix}/`))
        .filter((path) =>
          kind === "skills"
            ? /(?:^|\/)SKILL\.md$/.test(path)
            : /\.(?:md|mdc)$/.test(path),
        );
      if (configured !== undefined && matches.length === 0)
        throw new AppError("invalid_input", `插件组件不存在：${raw}`);
      for (const path of matches) {
        const source = read(path),
          front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
        const meta = front
          ? z
              .object({
                name: z.string().optional(),
                description: z.string().optional(),
              })
              .parse(parseYaml(front[1] ?? "", { maxAliasCount: 0 }) ?? {})
          : {};
        const fallback =
          path
            .split("/")
            .at(kind === "skills" ? -2 : -1)
            ?.replace(/\.(?:md|mdc)$/, "") ?? manifest.name;
        skills.push({
          name: `${manifest.name}:${meta.name ?? fallback}`.slice(0, 80),
          description: (
            meta.description ||
            manifest.description ||
            `${manifest.name} 的${kind === "rules" ? "规则" : "技能"}`
          ).slice(0, 500),
          body: source,
        });
      }
    }
  };
  collect("skills");
  collect("commands");
  collect("rules");
  if (
    new Set(
      skills.map((skill) => skill.name.normalize("NFKC").toLocaleLowerCase()),
    ).size !== skills.length
  )
    throw new AppError("invalid_input", "插件包含重复或过长后冲突的技能名称。");
  if (skills.length)
    warnings.push(
      "技能正文的相对资源路径不会自动成为本机文件授权；本地辅助脚本仅供插件 MCP 使用。",
    );
  if (
    manifest.rules !== undefined ||
    Object.keys(files).some((path) => path.startsWith("rules/"))
  )
    warnings.push("规则作为可按需读取的技能导入，不会自动覆盖 Bot 指令。");
  if (
    manifest.agents !== undefined ||
    Object.keys(files).some((path) => path.startsWith("agents/"))
  )
    warnings.push("子代理定义尚未执行。");
  if (
    manifest.hooks !== undefined ||
    Object.keys(files).some((path) => path.startsWith("hooks/"))
  )
    warnings.push("hooks 尚未执行。");
  const servers: PluginContent["servers"] = {};
  const merge = (value: unknown) => {
    const object = z.record(z.string(), z.unknown()).parse(value);
    const records = z
      .record(z.string(), z.unknown())
      .parse(object.mcpServers ?? object);
    for (const [name, config] of Object.entries(records)) {
      const raw = z.record(z.string(), z.unknown()).parse(config);
      if (raw.command !== undefined) {
        if (raw.cwd !== undefined)
          throw new AppError(
            "invalid_input",
            "插件 MCP 不支持自行指定本机工作目录。",
          );
        servers[name] = pluginMcpSchema.parse({
          command: raw.command,
          args: raw.args ?? [],
          env: raw.env ?? {},
        });
      } else {
        const parsed = pluginMcpSchema.parse({
          url: raw.url,
          type: raw.type ?? "http",
          headers: raw.headers ?? {},
        });
        if ("url" in parsed)
          pluginUrl(
            parsed.url.replace(
              /\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}/g,
              "placeholder",
            ),
          );
        servers[name] = parsed;
      }
    }
  };
  for (const path of [".mcp.json", "mcp.json"])
    if (files[path]) merge(JSON.parse(read(path)));
  if (manifest.mcpServers !== undefined)
    for (const value of Array.isArray(manifest.mcpServers)
      ? manifest.mcpServers
      : [manifest.mcpServers])
      merge(typeof value === "string" ? JSON.parse(read(value)) : value);
  const variables = new Set<string>();
  const declared = z
    .object({ properties: z.record(z.string(), z.unknown()).optional() })
    .safeParse(manifest.variables);
  for (const key of Object.keys(
    declared.success ? (declared.data.properties ?? {}) : {},
  ))
    variables.add(key);
  for (const match of JSON.stringify(servers).matchAll(
    /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g,
  ))
    if (
      match[1] &&
      !["CLAUDE_PLUGIN_ROOT", "CURSOR_PLUGIN_ROOT"].includes(match[1])
    )
      variables.add(match[1]);
  if (Object.keys(servers).length)
    warnings.push(
      "MCP 可使用配置变量或令牌；远程服务可在安装后连接账号。stdio 服务在本机运行。",
    );
  return pluginContentSchema.parse({
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    format: selected.startsWith(".cursor")
      ? "cursor"
      : selected.startsWith(".claude")
        ? "claude"
        : "generic",
    skills,
    servers,
    variables: [...variables],
    warnings,
    files,
  });
}
