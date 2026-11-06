/** Only the two application release channels are accepted at update boundaries. */
export function parseReleaseVersion(value: string) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-nightly\.(\d{8})\.([1-9]\d*))?$/.exec(
      value,
    );
  if (!match) throw new Error(`无效的发布版本：${value}`);
  const core = match.slice(1, 4).map(Number);
  const nightly = match[4] ? [Number(match[4]), Number(match[5])] : null;
  if (![...core, ...(nightly ?? [])].every(Number.isSafeInteger))
    throw new Error("版本号超出安全整数范围。");
  if (match[4]) {
    const date = match[4];
    const parsed = new Date(
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00Z`,
    );
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10).replaceAll("-", "") !== date
    )
      throw new Error("Nightly 日期无效。");
  }
  return { core, nightly, base: match.slice(1, 4).join(".") };
}

export function compareReleaseVersions(a: string, b: string) {
  const left = parseReleaseVersion(a);
  const right = parseReleaseVersion(b);
  for (let index = 0; index < 3; index++) {
    const difference = left.core[index]! - right.core[index]!;
    if (difference) return difference;
  }
  if (!left.nightly || !right.nightly)
    return Number(!left.nightly) - Number(!right.nightly);
  return (
    left.nightly[0]! - right.nightly[0]! || left.nightly[1]! - right.nightly[1]!
  );
}
