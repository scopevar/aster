import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

/** Real encoded video; text appears only in pixels, never in file metadata. */
export async function sampleVideo(
  directory: string,
  first = "FRAME_A",
  second = "FRAME_B",
  format: "mp4" | "webm" = "mp4",
) {
  if (![first, second].every((value) => /^[A-Za-z0-9_]{1,24}$/.test(value)))
    throw Error("Unsafe fixture text");
  for (const [index, text] of [first, second].entries()) {
    await sharp(
      Buffer.from(
        `<svg width="640" height="360" xmlns="http://www.w3.org/2000/svg"><rect width="640" height="360" fill="white"/><rect width="100" height="100" fill="${index ? "blue" : "red"}"/><text x="30" y="220" font-family="DejaVu Sans Mono, monospace" font-size="36" fill="black">${text}</text></svg>`,
      ),
    )
      .png()
      .toFile(join(directory, `frame-${index}.png`));
  }
  const path = join(directory, `clip.${format}`);
  const binary = process.env.ASTER_FFMPEG_DIR
    ? join(
        process.env.ASTER_FFMPEG_DIR,
        process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
      )
    : "ffmpeg";
  await promisify(execFile)(
    binary,
    [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-framerate",
      "1/2",
      "-i",
      join(directory, "frame-%d.png"),
      "-c:v",
      format === "mp4" ? "libx264" : "libvpx-vp9",
      "-pix_fmt",
      "yuv420p",
      ...(format === "mp4" ? ["-movflags", "+faststart"] : []),
      path,
    ],
    { windowsHide: true, timeout: 20000, maxBuffer: 65536 },
  );
  return { path, bytes: await readFile(path) };
}
