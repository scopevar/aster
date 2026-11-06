#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const SOURCE_ROOTS = ["src", "packages"];
const BASELINE_PATH = "config/architecture-cycles-baseline.txt";
const HEADER = [
  "# Existing runtime import cycles grandfathered by the architecture check.",
  "# The list may only shrink; new runtime cycles fail the check.",
  "# Format: repo-relative path -> ... -> repo-relative path",
  "",
].join("\n");
const EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

export function repositoryFiles(root, paths) {
  return execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...paths,
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  )
    .split("\0")
    .filter((file) => file && existsSync(path.join(root, file)));
}

function sourceFiles(root) {
  return repositoryFiles(root, SOURCE_ROOTS)
    .filter((file) => /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u.test(file))
    .filter(
      (file) =>
        !/\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u.test(file),
    )
    .filter((file) => !/\.d\.(?:ts|mts|cts)$/u.test(file));
}

export function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base];
  for (const extension of EXTENSIONS) {
    candidates.push(base + extension);
    candidates.push(path.join(base, "index" + extension));
  }
  const jsExtension = path.extname(base);
  if ([".js", ".mjs", ".cjs", ".jsx"].includes(jsExtension)) {
    const stem = base.slice(0, -jsExtension.length);
    for (const extension of [".ts", ".tsx", ".mts", ".cts"]) {
      candidates.push(stem + extension);
    }
  }
  return (
    candidates.find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    ) ?? null
  );
}

function localImports(file) {
  const source = readFileSync(file, "utf8");
  const kind =
    file.endsWith(".tsx") || file.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const imports = [];
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const target = resolveImport(file, statement.moduleSpecifier.text);
      if (!target) continue;
      const clause = ts.isImportDeclaration(statement)
        ? statement.importClause
        : null;
      const bindings = ts.isImportDeclaration(statement)
        ? clause?.namedBindings
        : statement.exportClause;
      const typeOnly =
        (ts.isImportDeclaration(statement) && clause?.isTypeOnly === true) ||
        (ts.isExportDeclaration(statement) && statement.isTypeOnly) ||
        (!clause?.name &&
          bindings !== undefined &&
          (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
          bindings.elements.length > 0 &&
          bindings.elements.every((element) => element.isTypeOnly));
      imports.push({ target, typeOnly });
    }
  }
  return imports;
}

function edgeTarget(edge) {
  return typeof edge === "string" ? edge : edge.target;
}

export function findCyclesFromGraph(graph) {
  const files = [...graph.keys()];
  const state = new Map();
  const stack = [];
  const cycles = [];

  const visit = (file) => {
    state.set(file, "visiting");
    stack.push(file);
    for (const edge of graph.get(file) ?? []) {
      const target = edgeTarget(edge);
      if (!graph.has(target)) continue;
      if (state.get(target) === "visiting") {
        const start = stack.indexOf(target);
        cycles.push([...stack.slice(start), target]);
      } else if (!state.has(target)) {
        visit(target);
      }
    }
    stack.pop();
    state.set(file, "done");
  };

  for (const file of files) if (!state.has(file)) visit(file);
  return cycles;
}

export function normalizeCycle(root, cycle) {
  return cycle
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .join(" -> ");
}

function loadBaseline(root) {
  try {
    return new Set(
      readFileSync(path.join(root, BASELINE_PATH), "utf8")
        .split(/\r?\n/u)
        .filter((line) => line && !line.startsWith("#")),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return new Set();
  }
}

export function analyzeArchitecture(root = process.cwd()) {
  const files = sourceFiles(root).map((file) => path.resolve(root, file));
  const graph = new Map(files.map((file) => [file, localImports(file)]));
  // Remove type edges before traversal so they cannot hide a runtime cycle.
  const runtimeGraph = new Map(
    [...graph].map(([file, edges]) => [
      file,
      edges.filter((edge) => !edge.typeOnly),
    ]),
  );
  const typeGraph = new Map(
    [...graph].map(([file, edges]) => [
      file,
      edges.filter((edge) => edge.typeOnly),
    ]),
  );
  const runtimeCycles = findCyclesFromGraph(runtimeGraph).map((cycle) =>
    normalizeCycle(root, cycle),
  );
  const typeCycles = findCyclesFromGraph(typeGraph).map((cycle) =>
    normalizeCycle(root, cycle),
  );
  return {
    runtimeCycles,
    typeCycles,
    moduleCycles: findModuleCycles(root, runtimeGraph),
  };
}

/** `src/<dir>` and `packages/<name>` are the units whose dependencies must point one way; root files share their root's unit. */
function moduleOf(root, file) {
  const parts = path.relative(root, file).split(path.sep);
  return parts.slice(0, parts.length > 2 ? 2 : 1).join("/");
}

function findModuleCycles(root, runtimeGraph) {
  // For each module edge, keep one file import as evidence for the report.
  const evidence = new Map();
  for (const [file, edges] of runtimeGraph) {
    const from = moduleOf(root, file);
    if (!evidence.has(from)) evidence.set(from, new Map());
    for (const edge of edges) {
      if (!runtimeGraph.has(edge.target)) continue;
      const to = moduleOf(root, edge.target);
      if (to === from || evidence.get(from).has(to)) continue;
      evidence.get(from).set(to, normalizeCycle(root, [file, edge.target]));
    }
  }
  const graph = new Map(
    [...evidence].map(([module, targets]) => [module, [...targets.keys()]]),
  );
  return findCyclesFromGraph(graph).map((cycle) =>
    cycle
      .slice(1)
      .map((module, index) => {
        const from = cycle[index];
        return `${from} -> ${module} [${evidence.get(from).get(module)}]`;
      })
      .join("; "),
  );
}

export function collectModuleCycles(root = process.cwd()) {
  return analyzeArchitecture(root).moduleCycles;
}

export function collectRuntimeCycles(root = process.cwd()) {
  return analyzeArchitecture(root).runtimeCycles;
}

export function findCycles(root = process.cwd()) {
  return collectRuntimeCycles(root);
}

function baselineText(cycles) {
  return HEADER + [...cycles].sort().join("\n") + (cycles.length ? "\n" : "");
}

export function writeBaseline(root = process.cwd()) {
  return baselineText(collectRuntimeCycles(root));
}

function hasBaseline(root) {
  return existsSync(path.join(root, BASELINE_PATH));
}

export function main(root = process.cwd(), args = process.argv.slice(2)) {
  const init = args.includes("--init-baseline");
  const write = args.includes("--write-baseline");
  if (init && hasBaseline(root)) {
    console.error(
      `${BASELINE_PATH} already exists; --init-baseline is one-time only. Split the cycle instead.`,
    );
    return 1;
  }
  if (!init && !write && !hasBaseline(root)) {
    console.error(
      `${BASELINE_PATH} is missing; run --init-baseline once, then commit the baseline.`,
    );
    return 1;
  }

  const { runtimeCycles: current, moduleCycles } = analyzeArchitecture(root);
  if (init) {
    writeFileSync(path.join(root, BASELINE_PATH), baselineText(current));
    console.log(
      `Initialized ${BASELINE_PATH} with ${current.length} runtime cycle(s).`,
    );
    return 0;
  }

  const baseline = loadBaseline(root);
  const added = current.filter((cycle) => !baseline.has(cycle));
  const stale = [...baseline].filter((cycle) => !current.includes(cycle));

  if (write) {
    if (added.length > 0) {
      console.error(
        "Refusing to write a larger baseline; resolve these new runtime cycles first:",
      );
      for (const cycle of added) console.error(`  ${cycle}`);
      return 1;
    }
    writeFileSync(path.join(root, BASELINE_PATH), baselineText(current));
    console.log(
      `Wrote ${BASELINE_PATH}: ${baseline.size - stale.length} grandfathered cycle(s).`,
    );
    return 0;
  }

  if (stale.length > 0) {
    console.log(
      `Architecture note: ${stale.length} baseline cycle(s) have been removed; shrink ${BASELINE_PATH}.`,
    );
  }
  if (added.length > 0) {
    console.error(`Found ${added.length} new runtime import cycle(s):`);
    for (const cycle of added) console.error(`  ${cycle}`);
  }
  // Module cycles have no baseline: move the shared piece to the lower module.
  if (moduleCycles.length > 0) {
    console.error(
      `Found ${moduleCycles.length} runtime dependency cycle(s) between modules:`,
    );
    for (const cycle of moduleCycles) console.error(`  ${cycle}`);
  }
  if (added.length > 0 || moduleCycles.length > 0) return 1;
  console.log(
    `Architecture check OK: ${current.length} grandfathered runtime cycle(s); no new runtime cycles and no module cycles in ${SOURCE_ROOTS.join(", ")}.`,
  );
  return 0;
}

if (import.meta.main) process.exitCode = main();
