import { z } from "zod";
import {
  compareReleaseVersions,
  parseReleaseVersion,
} from "../shared/desktop/release-version.js";
import { git, readPackage, writeVersion } from "./release-git.js";
import { githubRepositorySchema } from "../shared/desktop/update-source.js";

const recordSchema = z.object({
  version: z.string(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  channel: z.enum(["latest", "nightly"]),
  repository: githubRepositorySchema.optional(),
});

export async function releaseHistory(root: string) {
  const tags = (await git(root, ["tag", "--merged", "HEAD", "--list", "v*"]))
    .split("\n")
    .filter((tag) => /^v\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/.test(tag))
    .map((tag) => tag.slice(1))
    .sort(compareReleaseVersions);
  return {
    stable:
      tags.filter((version) => !parseReleaseVersion(version).nightly).at(-1) ??
      "0.0.0",
    nightly: tags
      .filter((version) => parseReleaseVersion(version).nightly)
      .at(-1),
  };
}

/** A published annotated tag binds promotion to tested source, even after main moves. */
export async function readNightly(
  root: string,
  version: string,
  repository?: string,
) {
  if (!parseReleaseVersion(version).nightly)
    throw new Error("请选择完整的 Nightly 版本号。");
  const tag = `refs/tags/v${version}`;
  const record = recordSchema.parse(
    JSON.parse(
      await git(root, ["for-each-ref", "--format=%(contents)", tag]),
    ) as unknown,
  );
  const source = await git(root, ["rev-parse", `${tag}^{commit}`]);
  if (
    record.channel !== "nightly" ||
    record.version !== version ||
    record.sourceCommit !== source
  )
    throw new Error("Nightly 发布记录与标签不一致。");
  if (repository && record.repository !== repository)
    throw new Error("请选择从当前 GitHub 更新仓库发布的 Nightly。");
  await git(root, ["merge-base", "--is-ancestor", source, "HEAD"]);
  return source;
}

export async function hasReleaseChanges(root: string, since: string) {
  const files = (await git(root, ["diff", "--name-only", since, "HEAD"])).split(
    "\n",
  );
  return files.some((file) => {
    if (/(^|\/)(tests|docs)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.md$/.test(file))
      return false;
    return /^(src\/|packages\/|resources\/|assets\/|scripts\/|patches\/|electron-builder\.|electron\.vite\.|postcss\.|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig|\.nvmrc$)/.test(
      file,
    );
  });
}

export async function tagCiRelease(
  root: string,
  record: z.infer<typeof recordSchema>,
) {
  parseReleaseVersion(record.version);
  const tag = `v${record.version}`;
  const message = JSON.stringify(recordSchema.parse(record));
  if (await git(root, ["tag", "--list", tag])) {
    if (
      (await git(root, ["rev-parse", `${tag}^{commit}`])) !==
        record.sourceCommit ||
      (await git(root, [
        "for-each-ref",
        "--format=%(contents)",
        `refs/tags/${tag}`,
      ])) !== message
    )
      throw new Error("已有发布标签与本次记录不一致。");
    return;
  }
  await git(root, ["tag", "-a", tag, record.sourceCommit, "-m", message]);
}

/** Sync the current release branch without grafting a version commit onto the candidate. */
export async function syncStableVersion(
  root: string,
  branch: "main" | "dev" = "main",
) {
  const { stable } = await releaseHistory(root);
  const current = (await readPackage(root)).data.version;
  if (compareReleaseVersions(current, stable) >= 0) return;
  await writeVersion(root, stable);
  await git(root, ["add", "--", "package.json"]);
  await git(root, [
    "commit",
    "-m",
    `chore(release): 同步正式版本 ${stable}`,
    "--",
    "package.json",
  ]);
  await git(root, ["push", "origin", `HEAD:refs/heads/${branch}`]);
}
