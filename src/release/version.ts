/** 发布入口只接受不带 v、预发布或前导零的正式 SemVer。 */
export function parseVersion(value: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`版本号 ${value} 必须是无前导零的 X.Y.Z。`);
  const parts = match.slice(1).map(Number);
  const [major, minor, patch] = parts;
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    !parts.every(Number.isSafeInteger)
  )
    throw new Error("版本号超出安全整数范围。");
  return { major, minor, patch };
}

export function compareVersions(a: string, b: string) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch
  );
}
