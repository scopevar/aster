import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compareVersions, parseVersion } from "../src/release/version.js";
import {
  git,
  requireCleanTree,
  writeVersion,
} from "../src/release/release-git.js";

void test("stable release versions require plain SemVer and compare numerically", () => {
  assert.deepEqual(parseVersion("0.0.1000"), {
    major: 0,
    minor: 0,
    patch: 1000,
  });
  assert.ok(compareVersions("0.0.1000", "0.0.999") > 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  assert.ok(compareVersions("0.9.9", "0.10.0") < 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  for (const version of [
    "v0.0.1",
    "0.0.001",
    "0.1",
    "0.1.0-beta.1",
    "9007199254740992.0.0",
  ])
    assert.throws(() => parseVersion(version));
});

void test("release Git helpers reject dirty trees and only update the package version", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-release-git-"));
  try {
    await git(root, ["init"]);
    await git(root, ["config", "user.name", "Release Test"]);
    await git(root, ["config", "user.email", "release@example.invalid"]);
    await writeFile(
      join(root, "package.json"),
      '{"name":"fixture","version":"0.0.0"}\n',
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "feat: initial"]);
    const head = await git(root, ["rev-parse", "HEAD"]);
    await requireCleanTree(root);
    await writeVersion(root, "0.0.1");
    await assert.rejects(requireCleanTree(root), /干净/);
    assert.deepEqual(
      JSON.parse(await readFile(join(root, "package.json"), "utf8")),
      { name: "fixture", version: "0.0.1" },
    );
    assert.equal(await git(root, ["rev-parse", "HEAD"]), head);
    assert.equal(await git(root, ["tag", "--list"]), "");
    const contents = await readFile(join(root, "package.json"), "utf8");
    assert.ok(contents.indexOf('"name"') < contents.indexOf('"version"'));
    await git(root, ["restore", "package.json"]);
    await requireCleanTree(root);
    await writeFile(join(root, "untracked.txt"), "untracked");
    await assert.rejects(requireCleanTree(root), /干净/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
