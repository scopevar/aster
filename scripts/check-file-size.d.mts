export type FileSizeViolation = {
  file: string;
  count: number;
  cap: number;
  reason: "budget" | "grew";
};

export function repositoryFiles(
  root: string,
  paths: readonly string[],
): string[];
export function countLines(file: string): number;
export function checkFileSizes(
  root?: string,
  baseline?: ReadonlyMap<string, number>,
  files?: readonly string[],
): {
  violations: FileSizeViolation[];
  baseline: Map<string, number>;
  current: Map<string, number>;
};
export function writeBaseline(root?: string): string;
export function main(root?: string, args?: readonly string[]): number;
