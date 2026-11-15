import { createReadStream, watchFile, unwatchFile } from "node:fs";
import { stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

/** Follow only newly appended daemon output; the daemon remains independently owned. */
export async function followDaemonLog(
  path,
  write = (text) => process.stdout.write(text),
) {
  let offset = 0;
  try {
    offset = (await stat(path)).size;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let decoder = new StringDecoder("utf8");
  let queued = Promise.resolve();
  let stopped = false;
  const read = async () => {
    try {
      const current = await stat(path);
      if (current.size < offset) {
        offset = 0;
        decoder = new StringDecoder("utf8");
      }
      if (current.size === offset) return;
      const stream = createReadStream(path, {
        start: offset,
        end: current.size - 1,
      });
      for await (const chunk of stream) {
        offset += chunk.length;
        write(decoder.write(chunk));
      }
    } catch (error) {
      if (error?.code !== "ENOENT")
        console.error("后台日志读取失败，请检查 daemon.log 的访问权限。");
    }
  };
  const changed = () => {
    if (!stopped) queued = queued.then(read);
  };
  watchFile(path, { interval: 250, persistent: false }, changed);
  return async () => {
    stopped = true;
    unwatchFile(path, changed);
    await queued;
    await read();
    write(decoder.end());
  };
}
