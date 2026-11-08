import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCiPlan, validateCiPlan } from "../src/release/ci-plan.js";
import {
  readNightly,
  tagCiRelease,
  syncStableVersion,
} from "../src/release/ci-history.js";
import { git, readPackage } from "../src/release/release-git.js";

// Real Git history owns scheduling and promotion: main may advance without
// changing the candidate, and only published Nightly records can be promoted.
void test("CI isolates preview, skips unchanged Nightlies and promotes exact tested source", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-ci-plan-"));
  const env = {
    GITHUB_REPOSITORY: "scopevar/aster",
    GITHUB_REF_NAME: "main",
    R2_SECRET_ACCESS_KEY: "must-never-enter-the-plan",
    GITHUB_RUN_NUMBER: "12",
  };
  const now = new Date("2026-10-28T20:00:00Z");
  const commit = async (message: string) => {
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", message]);
  };
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Release Test"]);
    await git(root, ["config", "user.email", "release@example.invalid"]);
    await writeFile(
      join(root, "package.json"),
      '{"name":"fixture","version":"0.0.1"}\n',
    );
    await commit("feat: initial application");
    await git(root, ["tag", "v0.0.1"]);
    await assert.rejects(
      createCiPlan(root, {}, "nightly"),
      /GITHUB_REPOSITORY/,
    );
    await assert.rejects(
      createCiPlan(
        root,
        { ...env, GITHUB_REPOSITORY: "https://github.com/scopevar/aster" },
        "nightly",
      ),
      /GITHUB_REPOSITORY/,
    );
    const preview = await createCiPlan(root, env, "preview");
    assert.equal(preview?.version, "0.0.1");
    assert.equal(preview?.publish, false);
    assert.equal(preview?.repository, "scopevar/aster");
    assert.equal(
      (await createCiPlan(root, { ...env, GITHUB_REF_NAME: "dev" }, "preview"))
        ?.branch,
      "dev",
    );
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "app.ts"), "export const feature = 1;\n");
    await commit("feat: small feature");
    const plan = await createCiPlan(root, env, "nightly", { now });
    assert.ok(plan);
    assert.equal(plan.version, "0.0.2-nightly.20261028.12");
    assert.equal(plan.repository, "scopevar/aster");
    assert.equal(plan.publish, true);
    assert.equal(plan.branch, "main");
    // The daily schedule must publish its first Nightly without prior history.
    assert.deepEqual(
      await createCiPlan(root, env, "nightly", { now, scheduled: true }),
      plan,
    );
    assert.equal(
      JSON.stringify(plan).includes(env.R2_SECRET_ACCESS_KEY),
      false,
    );
    assert.deepEqual(validateCiPlan(JSON.parse(JSON.stringify(plan))), plan);
    assert.throws(() => validateCiPlan({ ...plan, version: "../bad" }));
    assert.throws(
      () => validateCiPlan({ ...plan, channel: "latest" }),
      /不一致/,
    );
    assert.throws(() => validateCiPlan({ ...plan, repository: "../other" }));
    await assert.rejects(
      createCiPlan(root, env, "stable", { nightlyVersion: plan.version }),
    );
    await tagCiRelease(root, plan);
    await tagCiRelease(root, plan);
    assert.equal(
      await createCiPlan(root, env, "nightly", { now, scheduled: true }),
      null,
    );
    await assert.rejects(
      createCiPlan(
        root,
        { ...env, GITHUB_REPOSITORY: "other/aster" },
        "stable",
        {
          nightlyVersion: plan.version,
        },
      ),
      /当前 GitHub 更新仓库/,
    );
    await writeFile(join(root, "guide.md"), "documentation");
    await commit("docs: guide");
    await writeFile(join(root, "src", "app.test.ts"), "// test-only change\n");
    await commit("test: coverage only");
    assert.equal(
      await createCiPlan(root, env, "nightly", { now, scheduled: true }),
      null,
    );
    assert.equal(
      (
        await createCiPlan(
          root,
          { ...env, GITHUB_RUN_NUMBER: "13" },
          "nightly",
          { now },
        )
      )?.version,
      "0.0.2-nightly.20261028.13",
    );
    await writeFile(join(root, "src", "app.ts"), "export const feature = 2;\n");
    await commit("feat: untested newer feature");
    assert.ok(
      await createCiPlan(root, { ...env, GITHUB_RUN_NUMBER: "14" }, "nightly", {
        now,
        scheduled: true,
      }),
    );
    const stable = await createCiPlan(root, env, "stable", {
      nightlyVersion: plan.version,
    });
    assert.ok(stable);
    assert.equal(stable.sourceCommit, plan.sourceCommit);
    assert.notEqual(
      stable.sourceCommit,
      await git(root, ["rev-parse", "HEAD"]),
    );
    assert.equal(stable.version, "0.0.2");
    assert.equal(stable.repository, env.GITHUB_REPOSITORY);
    assert.equal(
      (
        await createCiPlan(root, env, "stable", {
          nightlyVersion: plan.version,
          version: "0.1.0",
        })
      )?.version,
      "0.1.0",
    );
    await assert.rejects(
      createCiPlan(root, env, "stable", {
        nightlyVersion: plan.version,
        version: "0.0.1",
      }),
      /高于/,
    );
    await tagCiRelease(root, stable);
    await assert.rejects(
      createCiPlan(root, env, "stable", { nightlyVersion: plan.version }),
      /高于/,
    );
    await assert.rejects(readNightly(root, "0.0.1"), /Nightly/);
    // Version recording prepares a PR diff without committing or pushing main.
    const remote = join(root, "remote.git");
    await git(root, ["init", "--bare", remote]);
    await writeFile(join(root, ".gitignore"), "remote.git/\n");
    await commit("chore: ignore fixture remote");
    await git(root, ["remote", "add", "origin", remote]);
    await git(root, ["push", "origin", "main"]);
    const main = await git(root, ["rev-parse", "HEAD"]);
    const recordedVersion = await syncStableVersion(root);
    assert.equal((await readPackage(root)).data.version, "0.0.2");
    assert.equal(await git(root, ["rev-parse", "HEAD"]), main);
    assert.equal(await git(root, ["rev-parse", "origin/main"]), main);
    assert.equal(
      await git(root, ["ls-remote", "origin", "refs/heads/main"]),
      `${main}\trefs/heads/main`,
    );
    assert.match(await git(root, ["diff", "--", "package.json"]), /0\.0\.2/);
    assert.equal(recordedVersion, "0.0.2");
    assert.equal(await syncStableVersion(root), undefined);
    await writeFile(join(root, "guide.md"), "uncommitted");
    await assert.rejects(createCiPlan(root, env, "preview"), /干净/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
