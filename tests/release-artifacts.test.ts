import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import {
  Provider,
  parseUpdateInfo,
  resolveFiles,
} from "electron-updater/out/providers/Provider.js";
import {
  collectArtifacts,
  inspectArtifact,
  writeVersionedManifest,
} from "../src/release/release-artifacts.js";

void test("Linux releases require matching artifact hashes and embedded blockmap metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-release-files-"));
  const bytes = Buffer.alloc(128, 42);
  try {
    const files = [];
    for (const name of ["aster-0.0.1-x64.AppImage", "aster-0.0.1-amd64.deb"]) {
      await writeFile(join(root, name), bytes);
      const artifact = await inspectArtifact(root, name);
      files.push({
        url: name,
        size: artifact.size,
        sha512: artifact.sha512,
        ...(name.endsWith("AppImage") ? { blockMapSize: 20 } : {}),
      });
    }
    const manifest = "latest-linux.yml";
    await writeFile(
      join(root, manifest),
      stringify({ version: "0.0.1", files }),
    );
    const artifacts = await collectArtifacts(root, manifest, "0.0.1");
    assert.equal(artifacts.at(-1)?.name, manifest);
    const image = artifacts[0];
    assert.ok(image);
    await writeFile(join(root, image.name), "tampered");
    await assert.rejects(
      collectArtifacts(root, manifest, "0.0.1"),
      /与清单不一致/,
    );
    await writeFile(
      join(root, manifest),
      stringify({
        version: "0.0.1",
        files: files.map(({ url, size, sha512 }) => ({ url, size, sha512 })),
      }),
    );
    await assert.rejects(collectArtifacts(root, manifest, "0.0.1"), /blockmap/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 验证实际安装器清单与 updater 的下载解析，覆盖 Windows 和版本目录的新发布契约。
void test("Windows releases require an intact installer and blockmap, and version directories resolve through the real updater", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-release-windows-"));
  try {
    const name = "aster-0.0.2-x64.exe";
    await writeFile(join(root, name), Buffer.alloc(128, 42));
    const installer = await inspectArtifact(root, name);
    const info = {
      version: "0.0.2",
      files: [{ url: name, size: installer.size, sha512: installer.sha512 }],
      path: name,
      sha512: installer.sha512,
      releaseDate: "2026-10-28T00:00:00.000Z",
    };
    const manifest = "latest.yml";
    await writeFile(join(root, manifest), stringify(info));
    await assert.rejects(
      collectArtifacts(root, manifest, "0.0.2", "win32"),
      /ENOENT/,
    );
    await writeFile(join(root, `${name}.blockmap`), Buffer.alloc(64, 1));
    const artifacts = await collectArtifacts(root, manifest, "0.0.2", "win32");
    assert.deepEqual(
      artifacts.map((file) => file.name),
      [name, `${name}.blockmap`, manifest],
    );
    await assert.rejects(
      collectArtifacts(root, manifest, "0.0.3", "win32"),
      /版本/,
    );
    const destination = join(root, "feed");
    await writeVersionedManifest(root, manifest, "0.0.2", destination);
    const feed = new URL("https://download.example/updates/v0/");
    const parsed = parseUpdateInfo(
      await readFile(join(destination, manifest), "utf8"),
      manifest,
      feed,
    );
    const resolved = resolveFiles(parsed, feed);
    assert.equal(parsed.path, `0.0.2/${name}`);
    assert.equal(new Date(parsed.releaseDate).toISOString(), info.releaseDate);
    assert.equal(resolved[0]?.url.href, `${feed}0.0.2/${name}`);
    assert.equal(resolved[0]?.info.sha512, installer.sha512);
    const blockmaps = await Provider.prototype.getBlockMapFiles(
      new URL(`0.0.2/${name}`, feed),
      "0.0.1",
      "0.0.2",
    );
    assert.deepEqual(
      blockmaps.map((url) => url.href),
      [
        `${feed}0.0.1/aster-0.0.1-x64.exe.blockmap`,
        `${feed}0.0.2/${name}.blockmap`,
      ],
    );
    await writeFile(
      join(root, manifest),
      stringify({ ...info, files: [info.files[0], info.files[0]] }),
    );
    await assert.rejects(
      collectArtifacts(root, manifest, "0.0.2", "win32"),
      /一个 NSIS/,
    );
    await writeFile(
      join(root, manifest),
      stringify({
        ...info,
        files: [{ ...info.files[0], url: "../outside.exe" }],
      }),
    );
    await assert.rejects(collectArtifacts(root, manifest, "0.0.2", "win32"));
    await writeFile(join(root, manifest), stringify(info));
    await writeFile(join(root, name), "changed");
    await assert.rejects(
      collectArtifacts(root, manifest, "0.0.2", "win32"),
      /与清单不一致/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
