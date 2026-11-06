export type ImportEdge = { target: string; typeOnly: boolean };

export function repositoryFiles(
  root: string,
  paths: readonly string[],
): string[];
export function resolveImport(
  fromFile: string,
  specifier: string,
): string | null;
export function findCyclesFromGraph(
  graph: ReadonlyMap<string, readonly (string | ImportEdge)[]>,
): string[][];
export function normalizeCycle(root: string, cycle: readonly string[]): string;
export function analyzeArchitecture(root?: string): {
  runtimeCycles: string[];
  typeCycles: string[];
  moduleCycles: string[];
};
export function collectRuntimeCycles(root?: string): string[];
export function collectModuleCycles(root?: string): string[];
export function findCycles(root?: string): string[];
export function writeBaseline(root?: string): string;
export function main(root?: string, args?: readonly string[]): number;
