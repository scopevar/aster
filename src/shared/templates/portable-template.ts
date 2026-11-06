import { AppError } from "../core.js";
import { defaultAvatar } from "../avatar.js";
import {
  templatePayloadSchema,
  type TemplatePayload,
  type templateSelectionSchema,
} from "./templates.js";
import type { z } from "zod";

/** Export only selected portable fields. Never serialize a Bot, plugin bundle, or connection. */
export function portableTemplate(
  payload: TemplatePayload,
  selection: z.infer<typeof templateSelectionSchema>,
) {
  const value = templatePayloadSchema.parse({
    format: 1,
    name: payload.name,
    description: selection.configuration ? payload.description : "",
    tags: selection.configuration ? payload.tags : "",
    language: selection.configuration ? payload.language : "auto",
    avatar: {
      shape: selection.configuration
        ? payload.avatar.shape
        : defaultAvatar.shape,
      color: selection.configuration
        ? payload.avatar.color
        : defaultAvatar.color,
      image: selection.configuration ? payload.avatar.image : null,
    },
    skills: payload.skills.filter((_, index) =>
      selection.skills.includes(index),
    ),
    routines: payload.routines.filter((_, index) =>
      selection.routines.includes(index),
    ),
    plugins: payload.plugins.filter((_, index) =>
      selection.plugins.includes(index),
    ),
  });
  const text = [
    value.name,
    value.description,
    value.tags,
    ...value.skills.flatMap(({ name, description, body }) => [
      name,
      description,
      body,
    ]),
    ...value.routines.flatMap(({ name, prompt }) => [name, prompt]),
    ...value.plugins.flatMap(({ name, version }) => [name, version]),
  ].join("\n");
  if (
    /(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|AKIA[A-Z0-9]{16}|Bearer\s+[a-zA-Z0-9._~+/-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^/\s@]+:[^/\s@]+@)/i.test(
      text,
    ) ||
    /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s*[=:]\s*["']?(?!\$\{|<|\[|YOUR_|REPLACE_)[a-zA-Z0-9_+/.=-]{8,}/i.test(
      text,
    )
  )
    throw new AppError(
      "invalid_input",
      "所选模板内容疑似包含密钥或登录令牌，请先编辑移除后再导出。",
    );
  const paths = text.matchAll(
    /(?:^|[\s"'`(=:])((?:[A-Za-z]:[\\/]|\\\\|file:\/\/|~[\\/]|\/(?!\/))[^\s"'`<>]+)/gu,
  );
  if (
    [...paths].some(
      (match) =>
        !/^\/(?:workspace|inputs|skills|history)(?:\/|$)/.test(match[1] ?? ""),
    )
  )
    throw new AppError(
      "invalid_input",
      "所选模板内容包含本机绝对路径，请改用相对路径或占位符后再导出。",
    );
  return value;
}
