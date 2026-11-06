import {
  readdir,
  readFile,
  realpath,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

function isPackageNotice(document) {
  return !document.name.includes("/");
}

async function noticeDocuments(directory, prefix = "") {
  const entries = await readdir(join(directory, prefix), {
    withFileTypes: true,
  });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const documents = [];
  for (const entry of entries) {
    const name = prefix + entry.name;
    if (
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      entry.name !== "node_modules"
    ) {
      documents.push(...(await noticeDocuments(directory, `${name}/`)));
    } else if (
      entry.isFile() &&
      (/(?:^|\/)(?:licenses?|notices?)\//i.test(prefix) ||
        /^(?:licen[cs]e|copying|notice|ofl)(?:[._-]|$)/i.test(entry.name))
    ) {
      const text = await readFile(join(directory, name), "utf8");
      if (text.trim() && !text.includes("\0")) documents.push({ name, text });
    }
  }
  if (prefix || documents.some(isPackageNotice)) return documents;
  const readme = entries.find(
    (entry) =>
      entry.isFile() && /^readme(?:\.md|\.markdown|\.txt)?$/i.test(entry.name),
  );
  if (!readme) return documents;
  const text = await readFile(join(directory, readme.name), "utf8");
  const heading = /^(?:#{1,6}\s+licen[cs]e\s*|licen[cs]e\r?\n[-=]+)\s*$/im.exec(
    text,
  );
  const notice = heading
    ? text
        .slice(heading.index + heading[0].length)
        .split(/^#{1,6}\s|^.+\r?\n[-=]{3,}\s*$/m)[0]
        ?.trim()
    : "";
  // A README link or SPDX label is not a substitute for the notice itself.
  if (
    notice &&
    /permission is hereby granted|redistribution and use|terms and conditions/i.test(
      notice,
    )
  )
    documents.push({ name: "LICENSE.from-README", text: notice });
  return documents;
}

async function dependencyManifest(name, from) {
  for (let current = from; ; current = dirname(current)) {
    const path = join(current, "node_modules", name, "package.json");
    if (existsSync(path)) return realpath(path);
    if (current === dirname(current)) return null;
  }
}

/** Preserve dependency notices and append the project's supplemental licenses. */
export async function collectLicenses(root, destination) {
  const seen = new Set();
  const inventory = [];
  const visit = async (path) => {
    const canonical = await realpath(path);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    const manifest = JSON.parse(await readFile(canonical, "utf8"));
    const directory = dirname(canonical);
    if (!["aster", "@aster/cli"].includes(manifest.name)) {
      const documents = await noticeDocuments(directory);
      const folder = `${encodeURIComponent(manifest.name)}-${manifest.version}`;
      const files = [];
      for (const document of documents) {
        const file = `${folder}/${document.name}.txt`;
        await mkdir(dirname(join(destination, file)), { recursive: true });
        await writeFile(join(destination, file), document.text);
        files.push(file);
      }
      inventory.push({
        name: manifest.name,
        version: manifest.version,
        license:
          manifest.license ??
          manifest.licenses ??
          (files.length ? "SEE INCLUDED LICENSE" : "UNKNOWN"),
        repository: manifest.repository ?? manifest.homepage ?? null,
        files,
        notice: documents
          .map((document) => `${document.name}\n\n${document.text.trim()}`)
          .join("\n\n"),
      });
    }
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      const dependency = await dependencyManifest(name, directory);
      if (dependency) await visit(dependency);
      else if (!(name in (manifest.optionalDependencies ?? {})))
        throw new Error(`缺少生产依赖的许可证清单：${name}`);
    }
  };
  await mkdir(destination, { recursive: true });
  await visit(join(root, "package.json"));
  inventory.sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  await writeFile(
    join(destination, "index.json"),
    JSON.stringify(
      inventory.map((entry) => ({
        name: entry.name,
        version: entry.version,
        license: entry.license,
        repository: entry.repository,
        files: entry.files,
      })),
      null,
      2,
    ) + "\n",
  );
  const supplementalFile = join(root, "THIRD_PARTY_LICENSES.txt");
  const supplemental = existsSync(supplementalFile)
    ? await readFile(supplementalFile, "utf8")
    : "";
  return (
    "Aster third-party licenses\n\n" +
    inventory
      .map(
        (entry) =>
          `${entry.name}@${entry.version}\nLicense: ${typeof entry.license === "string" ? entry.license : JSON.stringify(entry.license)}\n\n${entry.notice}`,
      )
      .join("\n\n" + "-".repeat(72) + "\n\n") +
    "\n\n" +
    supplemental
  );
}
