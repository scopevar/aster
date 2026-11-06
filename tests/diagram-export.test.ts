import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../src/shared/core.js";
import { validateDiagramSvg } from "../src/shared/files/diagram-export.js";
import { saveDiagramFile } from "../src/desktop/native/diagram-export.js";
import {
  diagramResult,
  diagramSvgMessage,
} from "../src/ui/features/files/diagram-contract.js";

const safe = `<svg xmlns="http://www.w3.org/2000/svg" id="diagram" viewBox="0 0 10 10"><style>#diagram .edge{stroke:#333}</style><path marker-end="url(#arrow)" d="M0 0"/><text>完成</text></svg>`;

function rejection(error: unknown, code: AppError["code"], message: string) {
  assert.ok(error instanceof AppError);
  assert.equal(error.code, code);
  assert.equal(error.message, message);
  return true;
}

await test("diagram export stays outside the render result and rejects active SVG", () => {
  const id = randomUUID();
  assert.equal(
    diagramResult.safeParse({
      version: 1,
      id,
      state: "ready",
      html: "<svg/>",
    }).success,
    false,
  );
  assert.equal(
    diagramResult.safeParse({
      version: 1,
      id,
      type: "svg",
      svg: safe,
    }).success,
    false,
  );
  assert.equal(
    diagramSvgMessage.safeParse({ version: 1, id, type: "svg", svg: safe })
      .success,
    true,
  );
  assert.equal(validateDiagramSvg(`\n${safe}\n`), safe);
  for (const svg of [
    `<svg><script>alert(1)</script></svg>`,
    `<svg><a href="javascript:alert(1)"></a></svg>`,
    `<svg onload="alert(1)"></svg>`,
    `<svg><foreignObject><div></div></foreignObject></svg>`,
    `<svg href="https://example.com"></svg>`,
    `<svg><image href="https://example.com/a.png"/></svg>`,
    `<svg><style>@import "https://example.com/a.css";</style></svg>`,
    `<svg><path style="filter:url(https://example.com/a)"/></svg>`,
    `not svg`,
    `<svg></svg><script></script>`,
    `<svg>${"x".repeat(2_000_000)}</svg>`,
  ]) {
    assert.throws(
      () => validateDiagramSvg(svg),
      (error: unknown) =>
        error instanceof AppError && error.code === "invalid_input",
    );
  }
});

await test("saving a diagram writes only a regular svg and refuses links or the installed app directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-diagram-"));
  const outside = await mkdtemp(join(tmpdir(), "aster-diagram-out-"));
  try {
    const path = join(directory, "chart.svg");
    assert.equal(await saveDiagramFile(path, safe), "chart.svg");
    const replaced = safe.replace("完成", "替换");
    assert.equal(await saveDiagramFile(path, replaced), "chart.svg");
    assert.equal(await readFile(path, "utf8"), replaced);
    const names = await readdir(directory);
    assert.equal(
      names.some(
        (name) => name.includes("partial") || name.includes("displaced"),
      ),
      false,
    );
    await assert.rejects(
      () => saveDiagramFile(join(directory, "notes.txt"), safe),
      (error: unknown) =>
        rejection(error, "invalid_input", "图表只能保存为 .svg 文件。"),
    );
    await mkdir(join(directory, "folder.svg"));
    await assert.rejects(
      () => saveDiagramFile(join(directory, "folder.svg"), safe),
      (error: unknown) =>
        rejection(
          error,
          "invalid_input",
          "图表必须保存为普通 SVG 文件，不能是链接或目录。",
        ),
    );
    const linked = join(directory, "linked");
    await symlink(outside, linked, "junction");
    await assert.rejects(
      () => saveDiagramFile(join(linked, "chart.svg"), safe),
      (error: unknown) => rejection(error, "invalid_input", "目标目录无效。"),
    );
    await assert.rejects(
      () => saveDiagramFile(join(outside, "chart.svg"), safe, outside),
      (error: unknown) =>
        rejection(error, "unauthorized", "不能把图表写进已安装程序目录。"),
    );
    assert.equal(await readFile(path, "utf8"), replaced);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
