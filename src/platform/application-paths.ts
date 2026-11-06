import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

/** Desktop and its packaged Node daemon must protect the same installation. */
export function installedApplicationDirectory(
  executable = process.execPath,
  electron = Boolean(process.versions.electron),
) {
  const directory = dirname(resolve(executable));
  if (electron) return directory;
  return basename(directory).toLowerCase() === "daemon-runtime" &&
    basename(dirname(directory)).toLowerCase() === "resources"
    ? dirname(dirname(directory))
    : undefined;
}

export function isApplicationPath(
  file: string,
  applicationDirectory = installedApplicationDirectory(),
) {
  if (!applicationDirectory) return false;
  const child = relative(resolve(applicationDirectory), resolve(file));
  return (
    child === "" ||
    (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))
  );
}
