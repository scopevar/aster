import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { parseReleaseVersion } from "../shared/desktop/release-version.js";

export const artifactSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
  size: z.number().int().positive(),
  sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});
export type ReleaseArtifact = z.infer<typeof artifactSchema>;
const manifestSchema = z.object({
  version: z.string(),
  files: z
    .array(
      z.object({
        url: artifactSchema.shape.name,
        size: artifactSchema.shape.size,
        sha512: artifactSchema.shape.sha512,
        blockMapSize: z.number().int().positive().optional(),
      }),
    )
    .min(1)
    .max(2),
});

export async function inspectArtifact(
  directory: string,
  name: string,
): Promise<ReleaseArtifact> {
  artifactSchema.shape.name.parse(name);
  const path = join(directory, name);
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`发布产物 ${name} 不是普通文件。`);
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return artifactSchema.parse({
    name,
    size: details.size,
    sha512: hash.digest("base64"),
  });
}

/** 校验安装包；Linux 使用内嵌 blockmap，Windows 同时发布独立 blockmap。 */
export async function collectArtifacts(
  directory: string,
  manifest: string,
  version: string,
  platform: "linux" | "win32" = "linux",
) {
  const info = manifestSchema.parse(
    parse(await readFile(join(directory, manifest), "utf8")) as unknown,
  );
  if (info.version !== version)
    throw new Error("更新清单版本与本次版本不一致。");
  const appImage = info.files.find((file) => file.url.endsWith(".AppImage"));
  const deb = info.files.find((file) => file.url.endsWith(".deb"));
  if (platform === "linux" && (!appImage?.blockMapSize || !deb))
    throw new Error("更新清单必须同时包含带 blockmap 的 AppImage 和 deb。");
  if (
    platform === "win32" &&
    (info.files.length !== 1 || !info.files[0]?.url.endsWith(".exe"))
  )
    throw new Error("Windows 更新清单必须包含一个 NSIS exe 安装包。");
  const files: ReleaseArtifact[] = [];
  for (const file of info.files) {
    if (!file.url.includes(`-${version}-`))
      throw new Error("安装包文件名必须包含本次版本。");
    const actual = await inspectArtifact(directory, file.url);
    if (actual.sha512 !== file.sha512 || actual.size !== file.size)
      throw new Error(`安装包 ${file.url} 与清单不一致。`);
    files.push(actual);
    if (platform === "win32")
      files.push(await inspectArtifact(directory, `${file.url}.blockmap`));
  }
  files.push(await inspectArtifact(directory, manifest));
  return files;
}

/** 固定入口的清单引用版本目录；不改变构建产物，失败时可原样重试。 */
export async function writeVersionedManifest(
  directory: string,
  manifest: string,
  version: string,
  destination: string,
) {
  parseReleaseVersion(version);
  artifactSchema.shape.name.parse(manifest);
  const info = manifestSchema
    .extend({
      path: artifactSchema.shape.name.optional(),
      sha512: artifactSchema.shape.sha512.optional(),
      releaseDate: z.string().optional(),
    })
    .parse(parse(await readFile(join(directory, manifest), "utf8")) as unknown);
  if (
    info.version !== version ||
    (info.path && !info.files.some((file) => file.url === info.path))
  )
    throw new Error("更新清单版本或默认下载路径不一致。");
  await mkdir(destination, { recursive: true });
  await writeFile(
    join(destination, manifest),
    stringify({
      ...info,
      files: info.files.map((file) => ({
        ...file,
        url: `${version}/${file.url}`,
      })),
      ...(info.path ? { path: `${version}/${info.path}` } : {}),
    }),
  );
  return inspectArtifact(destination, manifest);
}
