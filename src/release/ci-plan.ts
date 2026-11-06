import { z } from "zod";
import { git, readPackage, requireCleanTree } from "./release-git.js";
import { githubRepositorySchema } from "../shared/desktop/update-source.js";
import { parseVersion, compareVersions } from "./version.js";
import { parseReleaseVersion } from "../shared/desktop/release-version.js";
import {
  hasReleaseChanges,
  readNightly,
  releaseHistory,
} from "./ci-history.js";

export const ciPlanSchema = z.object({
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  channel: z.enum(["latest", "nightly"]),
  sourceNightly: z.string().optional(),
  branch: z.enum(["main", "dev"]),
  repository: githubRepositorySchema,
  publish: z.boolean(),
  version: z.string().refine((value) => {
    try {
      parseReleaseVersion(value);
      return true;
    } catch {
      return false;
    }
  }),
});
export type CiReleasePlan = z.infer<typeof ciPlanSchema>;

/** 计划只保存公开配置，让两个平台和失败重试使用同一份版本与地址。 */
export async function createCiPlan(
  root: string,
  env: NodeJS.ProcessEnv,
  mode: "preview" | "nightly" | "stable",
  options: {
    nightlyVersion?: string;
    version?: string;
    scheduled?: boolean;
    now?: Date;
  } = {},
): Promise<CiReleasePlan | null> {
  await requireCleanTree(root);
  let sourceCommit = await git(root, ["rev-parse", "HEAD"]);
  let version = (await readPackage(root)).data.version;
  const channel = mode === "nightly" ? "nightly" : "latest";
  const parsedRepository = githubRepositorySchema.safeParse(
    env.GITHUB_REPOSITORY,
  );
  if (!parsedRepository.success)
    throw new Error("GITHUB_REPOSITORY 必须使用 owner/repo 格式。");
  const repository = parsedRepository.data;
  const sourceBranch = env.GITHUB_BASE_REF || env.GITHUB_REF_NAME || "dev";
  const branch = z
    .enum(["main", "dev"])
    .parse(
      mode === "preview" && sourceBranch !== "main" ? "dev" : sourceBranch,
    );
  if (mode !== "preview") {
    const history = await releaseHistory(root);
    if (mode === "stable") {
      sourceCommit = await readNightly(
        root,
        options.nightlyVersion ?? "",
        repository,
      );
      version =
        options.version?.trim() ||
        parseReleaseVersion(options.nightlyVersion ?? "").base;
      parseVersion(version);
      if (compareVersions(version, history.stable) <= 0)
        throw new Error("正式版本必须高于已发布版本。");
    } else {
      if (
        options.scheduled &&
        history.nightly &&
        !(await hasReleaseChanges(
          root,
          await readNightly(root, history.nightly),
        ))
      )
        return null;
      const { major, minor, patch } = parseVersion(history.stable);
      const date = (options.now ?? new Date())
        .toISOString()
        .slice(0, 10)
        .replaceAll("-", "");
      const run = z
        .string()
        .regex(/^[1-9]\d*$/)
        .parse(env.GITHUB_RUN_NUMBER);
      version = `${major}.${minor}.${patch + 1}-nightly.${date}.${run}`;
    }
    if (await git(root, ["tag", "--list", `v${version}`]))
      throw new Error("此版本已经发布。");
  }
  return validateCiPlan({
    sourceCommit,
    channel,
    ...(mode === "stable" ? { sourceNightly: options.nightlyVersion } : {}),
    version,
    branch,
    repository,
    publish: mode !== "preview",
  });
}

export function validateCiPlan(input: unknown): CiReleasePlan {
  const plan = ciPlanSchema.parse(input);
  if (
    Boolean(parseReleaseVersion(plan.version).nightly) !==
    (plan.channel === "nightly")
  )
    throw new Error("版本与发布通道不一致。");
  return plan;
}
