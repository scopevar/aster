import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { collectLicenses } from "../scripts/collect-licenses.mjs";

async function fixture(t: TestContext, dependencies: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "aster-licenses-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "aster", dependencies }),
  );
  return { root, destination: join(root, "output") };
}

async function dependency(
  root: string,
  name: string,
  manifest: object,
  files: Record<string, string>,
) {
  const directory = join(root, "node_modules", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name, version: "1.0.0", ...manifest }),
  );
  for (const [name, text] of Object.entries(files)) {
    const file = join(directory, name);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, text);
  }
}

// Real package trees protect shipped notices, including resource licenses and
// missing npm notice files supplemented by the single repository text file.
await test("production notices preserve original files, nested resources and supplemental text", async (t) => {
  const { root, destination } = await fixture(t, { alpha: "1.0.0" });
  await dependency(
    root,
    "alpha",
    {
      license: "MIT",
      dependencies: { beta: "1.0.0" },
      optionalDependencies: { absent: "1.0.0" },
      devDependencies: { development: "1.0.0" },
    },
    {
      LICENSE: "Copyright Alpha\nPermission is hereby granted.",
      "dist/assets/LICENSE_font": "Bundled font notice",
    },
  );
  await dependency(
    root,
    "beta",
    { license: "BSD-2-Clause" },
    { COPYING: "Beta copyright and redistribution conditions" },
  );
  await writeFile(
    join(root, "THIRD_PARTY_LICENSES.txt"),
    "Native library copyright and full license",
  );
  const text = await collectLicenses(root, destination);
  assert.match(text, /Copyright Alpha/);
  assert.match(text, /Beta copyright/);
  assert.match(text, /Bundled font notice/);
  assert.match(text, /Native library copyright and full license/);
  assert.doesNotMatch(text, /development@/);
  assert.doesNotMatch(text, /absent@/);
  assert.equal(
    await readFile(join(destination, "alpha-1.0.0/LICENSE.txt"), "utf8"),
    "Copyright Alpha\nPermission is hereby granted.",
  );
  const inventory: unknown = JSON.parse(
    await readFile(join(destination, "index.json"), "utf8"),
  );
  assert.ok(Array.isArray(inventory));
  assert.equal(inventory.length, 2);
});

await test("README license grants are retained and a supplemental file is optional", async (t) => {
  const { root, destination } = await fixture(t, { alpha: "1.0.0" });
  await dependency(
    root,
    "alpha",
    { license: "MIT" },
    {
      "README.md":
        "# Package\n\nLicense\n-------\n\nCopyright Readme\nPermission is hereby granted.\n\nDevelopment\n-----------\nPrivate development instructions",
    },
  );
  const text = await collectLicenses(root, destination);
  assert.match(text, /Copyright Readme/);
  assert.doesNotMatch(text, /Private development/);
});

await test("a package missing its own notice keeps supplemental and nested vendor notices", async (t) => {
  const { root, destination } = await fixture(t, { alpha: "1.0.0" });
  await dependency(
    root,
    "alpha",
    { license: "MIT" },
    { "LICENSES/vendor.txt": "Nested vendor copyright" },
  );
  await writeFile(
    join(root, "THIRD_PARTY_LICENSES.txt"),
    "alpha@1.0.0\nCopyright Alpha\nPermission is hereby granted.",
  );
  const text = await collectLicenses(root, destination);
  assert.match(text, /Nested vendor copyright/);
  assert.match(text, /Copyright Alpha/);
});
