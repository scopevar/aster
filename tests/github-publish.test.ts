import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { z } from "zod";
import type { CiReleasePlan } from "../src/release/ci-plan.js";
import { publishGitHubRelease } from "../src/release/github-publish.js";
import { inspectArtifact } from "../src/release/release-artifacts.js";

// The real publisher and file streams cross HTTP. Only GitHub's API is replaced.
async function fixture(nightly = false) {
  const root = await mkdtemp(join(tmpdir(), "aster-github-release-"));
  const plan: CiReleasePlan = {
    sourceCommit: "a".repeat(40),
    branch: "dev",
    repository: "scopevar/aster",
    channel: nightly ? "nightly" : "latest",
    version: nightly ? "0.0.2-nightly.20261101.12" : "0.0.2",
    publish: true,
  };
  const assets = new Map<
    string,
    { name: string; body: Buffer; size: number; state: string; digest: string }
  >();
  const events: string[] = [];
  const state = {
    private: false,
    created: false,
    draft: true,
    prerelease: false,
    makeLatest: "false",
    failUpload: "",
  };
  const release = () => ({
    id: 1,
    tag_name: `v${plan.version}`,
    target_commitish: plan.sourceCommit,
    draft: state.draft,
    prerelease: state.prerelease,
    assets: [...assets.values()].map((asset) => ({
      name: asset.name,
      size: asset.size,
      state: asset.state,
      digest: asset.digest,
    })),
  });
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = request.method ?? "GET";
      events.push(`${method} ${path}`);
      const json = (data: unknown) => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(data));
      };
      if (method === "GET" && path === "/repos/scopevar/aster") {
        json({ private: state.private });
        return;
      }
      if (method === "GET" && path.endsWith("/releases")) {
        json(state.created ? [release()] : []);
        return;
      }
      if (method === "GET" && path.includes("/releases/")) {
        if (!state.created || (path.includes("/tags/") && state.draft))
          response.writeHead(404).end();
        else json(release());
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (method === "POST" && path.endsWith("/releases")) {
        const data = z
          .object({ draft: z.literal(true), prerelease: z.boolean() })
          .parse(JSON.parse(body.toString()) as unknown);
        state.created = true;
        state.prerelease = data.prerelease;
        json(release());
        return;
      }
      if (method === "POST" && path.endsWith("/assets")) {
        const name = url.searchParams.get("name") ?? "";
        if (state.failUpload === name) {
          response.writeHead(503).end();
          return;
        }
        if (assets.has(name)) {
          response.writeHead(422).end();
          return;
        }
        const asset = {
          name,
          body,
          size: body.length,
          state: "uploaded",
          digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
        };
        assets.set(name, asset);
        json(asset);
        return;
      }
      if (method === "PATCH" && path.endsWith("/releases/1")) {
        const data = z
          .object({
            draft: z.literal(false),
            prerelease: z.boolean(),
            make_latest: z.enum(["true", "false"]),
          })
          .parse(JSON.parse(body.toString()) as unknown);
        state.draft = data.draft;
        state.prerelease = data.prerelease;
        state.makeLatest = data.make_latest;
        json(release());
        return;
      }
      response.writeHead(404).end();
    })().catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const request: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    assert.ok(["api.github.com", "uploads.github.com"].includes(url.hostname));
    return fetch(new URL(url.pathname + url.search, origin), init);
  };
  const close = async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  };
  try {
    for (const platform of ["linux", "win32"] as const) {
      const directory = join(root, "release", "ci", `${platform}-x64`);
      await mkdir(directory, { recursive: true });
      const extensions = platform === "linux" ? ["AppImage", "deb"] : ["exe"];
      const files = [];
      for (const extension of extensions) {
        const name = `aster-${plan.version}-x64.${extension}`;
        await writeFile(join(directory, name), Buffer.alloc(128, 42));
        const file = await inspectArtifact(directory, name);
        files.push({
          url: name,
          size: file.size,
          sha512: file.sha512,
          ...(extension === "AppImage" ? { blockMapSize: 8 } : {}),
        });
        if (extension === "exe")
          await writeFile(
            join(directory, `${name}.blockmap`),
            "blockmap bytes",
          );
      }
      await writeFile(
        join(
          directory,
          `${plan.channel}${platform === "linux" ? "-linux" : ""}.yml`,
        ),
        stringify({ version: plan.version, files }),
      );
    }
    return { root, plan, state, assets, events, request, close };
  } catch (error) {
    await close();
    throw error;
  }
}

void test("GitHub drafts resume original assets and become public only after both platforms and the source tag are ready", async () => {
  const f = await fixture();
  try {
    const options = {
      token: "fixture-token",
      request: f.request,
      beforePublish: async () => {
        assert.equal(f.assets.size, 7);
        assert.equal(f.state.draft, true);
        f.events.push("source tag ready");
      },
    };
    f.state.failUpload = "aster-0.0.2-x64.exe";
    await assert.rejects(
      publishGitHubRelease(f.root, f.plan, options),
      /HTTP 503/,
    );
    assert.equal(f.state.draft, true);
    assert.equal(f.assets.size, 3);
    assert.equal(f.events.includes("source tag ready"), false);
    f.state.failUpload = "";
    await assert.rejects(
      publishGitHubRelease(f.root, f.plan, {
        ...options,
        beforePublish: async () => {
          throw new Error("tag push failed");
        },
      }),
      /tag push failed/,
    );
    assert.equal(f.state.draft, true);
    assert.equal(f.assets.size, 7);
    const url = await publishGitHubRelease(f.root, f.plan, options);
    assert.equal(url, "https://github.com/scopevar/aster/releases/tag/v0.0.2");
    assert.equal(f.state.draft, false);
    assert.equal(f.state.prerelease, false);
    assert.equal(f.state.makeLatest, "true");
    assert.ok(
      f.events.indexOf("source tag ready") <
        f.events.indexOf("PATCH /repos/scopevar/aster/releases/1"),
    );
    const uploads = f.events.filter((event) =>
      event.startsWith("POST "),
    ).length;
    await publishGitHubRelease(f.root, f.plan, {
      ...options,
      beforePublish: async () => undefined,
    });
    assert.equal(
      f.events.filter((event) => event.startsWith("POST ")).length,
      uploads,
    );
    const record = f.assets.get("release.json")?.body.toString() ?? "";
    assert.ok(record.includes(f.plan.sourceCommit));
    assert.equal(record.includes(options.token), false);
    const manifest = f.assets.get("latest.yml");
    assert.ok(manifest);
    manifest.digest = "sha256:" + "0".repeat(64);
    await assert.rejects(
      publishGitHubRelease(f.root, f.plan, options),
      /拒绝覆盖/,
    );
  } finally {
    await f.close();
  }
});

void test("GitHub publishing rejects private repositories and corrupt installers, and Nightly never becomes latest", async () => {
  const f = await fixture(true);
  try {
    const options = {
      token: "fixture-token",
      request: f.request,
      beforePublish: async () => undefined,
    };
    f.state.private = true;
    await assert.rejects(
      publishGitHubRelease(f.root, f.plan, options),
      /公开仓库/,
    );
    assert.equal(f.state.created, false);
    f.state.private = false;
    await publishGitHubRelease(f.root, f.plan, options);
    assert.equal(f.state.prerelease, true);
    assert.equal(f.state.makeLatest, "false");
    const requests = f.events.length;
    await writeFile(
      join(
        f.root,
        "release",
        "ci",
        "win32-x64",
        `aster-${f.plan.version}-x64.exe`,
      ),
      "corrupt installer",
    );
    await assert.rejects(
      publishGitHubRelease(f.root, f.plan, options),
      /与清单不一致/,
    );
    assert.equal(f.events.length, requests);
  } finally {
    await f.close();
  }
});
