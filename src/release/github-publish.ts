import { createHash } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { validateCiPlan, type CiReleasePlan } from "./ci-plan.js";
import { collectArtifacts, inspectArtifact } from "./release-artifacts.js";

const assetSchema = z.object({
  name: z.string(),
  size: z.number().int().nonnegative(),
  state: z.string(),
  digest: z.string().nullable().optional(),
});
const releaseSchema = z.object({
  id: z.number().int().positive(),
  tag_name: z.string(),
  target_commitish: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(assetSchema),
});
type GitHubAsset = z.infer<typeof assetSchema>;

/** 两个平台校验通过后才创建草稿；文件齐全、源码标签已推送后才公开。 */
export async function publishGitHubRelease(
  root: string,
  input: CiReleasePlan,
  options: {
    token: string;
    beforePublish(): Promise<void>;
    signal?: AbortSignal;
    request?: typeof fetch;
  },
) {
  const plan = validateCiPlan(input);
  if (!plan.publish) throw new Error("预览构建不能发布 GitHub Release。");
  if (!options.token.trim()) throw new Error("发布需要 GITHUB_TOKEN。");
  const files = await prepareAssets(root, plan);
  const request = options.request ?? fetch;
  const base = `/repos/${plan.repository}`;
  const tag = `v${plan.version}`;
  const prerelease = plan.channel === "nightly";
  const api = async (
    path: string,
    init: RequestInit = {},
    allowMissing = false,
    upload = false,
  ): Promise<unknown> => {
    const response = await request(
      `https://${upload ? "uploads" : "api"}.github.com${path}`,
      {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${options.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          ...init.headers,
        },
        signal: options.signal ?? null,
        redirect: "error",
      },
    );
    if (allowMissing && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub 发布请求失败（HTTP ${response.status}）。`);
    }
    return response.json();
  };
  const repository = z.object({ private: z.boolean() }).parse(await api(base));
  if (repository.private)
    throw new Error(
      "GitHub 自动更新需要公开仓库；请先完成代码公开，再执行发布。",
    );
  if (plan.sourceNightly) {
    const candidate = releaseSchema.parse(
      await api(`${base}/releases/tags/v${plan.sourceNightly}`),
    );
    if (
      candidate.draft ||
      !candidate.prerelease ||
      candidate.target_commitish !== plan.sourceCommit
    )
      throw new Error("候选 Nightly 尚未完成 GitHub 发布或源码不一致。");
  }
  let existing = await api(`${base}/releases/tags/${tag}`, {}, true);
  // The tag endpoint describes published releases; drafts are listed for writers.
  for (let page = 1; existing === null; page++) {
    const releases = z
      .array(releaseSchema)
      .parse(await api(`${base}/releases?per_page=100&page=${page}`));
    existing = releases.find((release) => release.tag_name === tag) ?? null;
    if (releases.length < 100) break;
  }
  let release = releaseSchema.parse(
    existing ??
      (await api(`${base}/releases`, {
        method: "POST",
        body: JSON.stringify({
          tag_name: tag,
          target_commitish: plan.sourceCommit,
          name: `Aster ${plan.version}`,
          body: `源码提交：${plan.sourceCommit}\n\n安装包、更新清单和校验记录见附件。`,
          draft: true,
          prerelease,
          make_latest: "false",
        }),
      })),
  );
  if (
    release.tag_name !== tag ||
    release.target_commitish !== plan.sourceCommit ||
    release.prerelease !== prerelease
  )
    throw new Error("已有 GitHub Release 与本次版本、源码或通道不一致。");
  for (const asset of release.assets) {
    const file = files.find((file) => file.name === asset.name);
    if (!file || !matchesAsset(asset, file))
      throw new Error(`已有附件 ${asset.name} 与原产物不一致，拒绝覆盖。`);
  }
  for (const file of files) {
    if (release.assets.some((asset) => asset.name === file.name)) continue;
    if (!release.draft) throw new Error("已公开的版本缺少附件，拒绝修改。");
    const uploaded = assetSchema.parse(
      await api(
        `${base}/releases/${release.id}/assets?name=${encodeURIComponent(file.name)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: await openAsBlob(file.path),
        },
        false,
        true,
      ),
    );
    if (!matchesAsset(uploaded, file))
      throw new Error(`GitHub 附件 ${file.name} 未通过上传校验。`);
  }
  release = releaseSchema.parse(await api(`${base}/releases/${release.id}`));
  if (
    release.assets.length !== files.length ||
    files.some(
      (file) =>
        !release.assets.some(
          (asset) => asset.name === file.name && matchesAsset(asset, file),
        ),
    )
  )
    throw new Error("GitHub Release 附件不完整或哈希不一致，保留草稿。");
  await options.beforePublish();
  if (release.draft) {
    const published = releaseSchema.parse(
      await api(`${base}/releases/${release.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          draft: false,
          prerelease,
          make_latest: prerelease ? "false" : "true",
        }),
      }),
    );
    if (published.draft || published.prerelease !== prerelease)
      throw new Error("GitHub Release 尚未公开，请重试发布任务。");
  }
  return `https://github.com/${plan.repository}/releases/tag/${tag}`;
}

function matchesAsset(
  asset: GitHubAsset,
  file: { size: number; digest: string },
) {
  return (
    asset.state === "uploaded" &&
    asset.size === file.size &&
    asset.digest === file.digest
  );
}

async function prepareAssets(root: string, plan: CiReleasePlan) {
  const files = [];
  const artifacts = [];
  for (const platform of ["linux", "win32"] as const) {
    const directory = join(root, "release", "ci", `${platform}-x64`);
    const manifest = `${plan.channel}${platform === "linux" ? "-linux" : ""}.yml`;
    const collected = await collectArtifacts(
      directory,
      manifest,
      plan.version,
      platform,
    );
    for (const artifact of collected) {
      artifacts.push({ platform, ...artifact });
      files.push({ path: join(directory, artifact.name), ...artifact });
    }
  }
  const directory = join(root, ".runtime", "ci-publish");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "release.json"),
    JSON.stringify({ plan, artifacts }, null, 2) + "\n",
  );
  files.push({
    path: join(directory, "release.json"),
    ...(await inspectArtifact(directory, "release.json")),
  });
  const prepared = [];
  for (const file of files) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file.path)) hash.update(chunk);
    prepared.push({ ...file, digest: `sha256:${hash.digest("hex")}` });
  }
  return prepared;
}
