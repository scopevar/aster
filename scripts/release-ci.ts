import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  createCiPlan,
  validateCiPlan,
  type CiReleasePlan,
} from "../src/release/ci-plan.js";
import { runCommand } from "../src/release/command.js";
import {
  git,
  requireCleanTree,
  writeVersion,
} from "../src/release/release-git.js";
import { syncStableVersion, tagCiRelease } from "../src/release/ci-history.js";
import { collectArtifacts } from "../src/release/release-artifacts.js";
import { publishGitHubRelease } from "../src/release/github-publish.js";

export async function runCiRelease(root: string, args: string[]) {
  const [command, ...rest] = args;
  const planPath = join(root, ".runtime", "ci-release-plan.json");
  if (command === "sync-version" && rest.length === 0) {
    await requireCleanTree(root);
    const version = await syncStableVersion(root);
    if (process.env.GITHUB_OUTPUT)
      await appendFile(process.env.GITHUB_OUTPUT, `version=${version ?? ""}\n`);
    return;
  }
  if (command === "plan") {
    const mode = z
      .enum(["preview", "nightly", "stable"])
      .parse(rest[0] ?? "preview");
    if (rest.length > 1) throw new Error("plan 参数过多。");
    const plan = await createCiPlan(root, process.env, mode, {
      nightlyVersion: process.env.NIGHTLY_VERSION ?? "",
      version: process.env.STABLE_VERSION ?? "",
      scheduled: process.env.GITHUB_EVENT_NAME === "schedule",
    });
    if (process.env.GITHUB_OUTPUT)
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `version=${plan?.version ?? ""}\npublish=${Boolean(plan?.publish)}\nsource=${plan?.sourceCommit ?? ""}\nplan=${JSON.stringify(plan)}\n`,
      );
    if (!plan) {
      console.info("没有需要发布的提交。");
      return;
    }
    await mkdir(join(root, ".runtime"), { recursive: true });
    await writeFile(planPath, JSON.stringify(plan, null, 2) + "\n");
    console.info(`已规划 ${plan.version}，源码 ${plan.sourceCommit}。`);
    return;
  }
  if (!["build", "publish"].includes(command ?? "") || rest.length)
    throw new Error(
      "用法：pnpm release --ci plan [preview|nightly|stable]，或 --ci build / publish / sync-version。",
    );
  const plan = validateCiPlan(
    JSON.parse(
      process.env.ASTER_CI_PLAN ?? (await readFile(planPath, "utf8")),
    ) as unknown,
  );
  await requireCleanTree(root);
  if ((await git(root, ["rev-parse", "HEAD"])) !== plan.sourceCommit)
    throw new Error("源码提交与构建计划不一致。");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (command === "build") await build(root, plan, controller.signal);
    else await publish(root, plan, controller.signal);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

async function build(root: string, plan: CiReleasePlan, signal: AbortSignal) {
  const platform = process.platform;
  if ((platform !== "linux" && platform !== "win32") || process.arch !== "x64")
    throw new Error("CI 打包仅支持 Linux / Windows x64 原生构建。");
  const original = await readFile(join(root, "package.json"), "utf8");
  const env = {
    ...process.env,
    ASTER_UPDATE_REPOSITORY: plan.repository,
    ASTER_RELEASE_CHANNEL: plan.channel,
  };
  const directory = join(root, "release", "ci", `${platform}-x64`);
  try {
    await writeVersion(root, plan.version);
    await runCommand(process.execPath, [join(root, "scripts", "build.mjs")], {
      cwd: root,
      env,
      signal,
      inherit: true,
    });
    await runCommand(
      process.execPath,
      [
        join(root, "node_modules", "electron-builder", "cli.js"),
        ...(platform === "linux"
          ? ["--linux", "AppImage", "deb"]
          : ["--win", "nsis"]),
        "--x64",
        "--publish",
        "never",
        `--config.directories.output=${directory}`,
      ],
      { cwd: root, env, signal, inherit: true },
    );
    await collectArtifacts(
      directory,
      `${plan.channel}${platform === "linux" ? "-linux" : ""}.yml`,
      plan.version,
      platform,
    );
  } finally {
    await writeFile(join(root, "package.json"), original);
  }
}

async function publish(root: string, plan: CiReleasePlan, signal: AbortSignal) {
  await git(root, ["fetch", "origin", plan.branch]);
  await git(root, [
    "merge-base",
    "--is-ancestor",
    plan.sourceCommit,
    "FETCH_HEAD",
  ]);
  const url = await publishGitHubRelease(root, plan, {
    token: process.env.GITHUB_TOKEN ?? "",
    signal,
    beforePublish: async () => {
      await tagCiRelease(root, plan);
      await git(root, ["push", "origin", `refs/tags/v${plan.version}`]);
    },
  });
  console.info(`已发布 Linux / Windows ${plan.version}：${url}`);
}
