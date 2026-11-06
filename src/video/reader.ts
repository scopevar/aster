import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { imageSize } from "image-size";
import { AppError } from "../shared/core.js";
import { maxAttachmentBytes } from "../shared/files/attachments.js";
import {
  videoOperationSchema,
  videoResultSchema,
  type VideoOperation,
  type VideoResult,
} from "../shared/files/video.js";

const metadata = z.object({
  streams: z
    .array(
      z.object({
        codec_type: z.string(),
        width: z.number().int().positive().max(8192).optional(),
        height: z.number().int().positive().max(8192).optional(),
      }),
    )
    .max(32),
  format: z.object({ duration: z.string().optional() }),
});

/** Owns the decoder process tree and input file until it has actually exited. */
export class VideoReader {
  private readonly lifetime = new AbortController();
  private readonly tasks = new Set<Promise<VideoResult>>();
  private readonly componentDirectory = process.env.ASTER_FFMPEG_DIR;
  read(
    bytes: Uint8Array,
    name: string,
    operation: VideoOperation,
    signal: AbortSignal,
  ): Promise<VideoResult> {
    signal.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    if (this.tasks.size >= 2)
      throw new AppError("capacity", "视频读取通道已满，请稍后重试。");
    if (bytes.byteLength > maxAttachmentBytes)
      throw new AppError("capacity", "视频最多 25 MiB。");
    const input = videoOperationSchema.parse(operation);
    const linked = AbortSignal.any([
      signal,
      this.lifetime.signal,
      AbortSignal.timeout(20000),
    ]);
    const task = this.perform(bytes, name, input, linked);
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }
  async close() {
    this.lifetime.abort();
    await Promise.allSettled([...this.tasks]);
  }
  private binary(name: string) {
    const directory = this.componentDirectory;
    if (directory && !isAbsolute(directory))
      throw new AppError(
        "unavailable",
        "ASTER_FFMPEG_DIR 必须是组件目录的绝对路径。",
      );
    return directory
      ? join(directory, process.platform === "win32" ? `${name}.exe` : name)
      : name;
  }
  private async perform(
    bytes: Uint8Array,
    name: string,
    operation: VideoOperation,
    signal: AbortSignal,
  ): Promise<VideoResult> {
    const format = /\.mp4$/i.test(name)
      ? "mov"
      : /\.webm$/i.test(name)
        ? "matroska"
        : null;
    if (!format)
      throw new AppError("invalid_input", "视频画面读取仅支持 MP4 和 WebM。");
    const ffmpeg = this.binary("ffmpeg"),
      ffprobe = this.binary("ffprobe");
    for (const [binary, label] of [
      [ffmpeg, "ffmpeg"],
      [ffprobe, "ffprobe"],
    ] as const) {
      const version = await this.run(binary, ["-version"], signal, 16384);
      if (
        !new RegExp(`^${label} version 8\\.0\\.1(?:[-\\s]|$)`).test(
          version.toString("utf8"),
        )
      )
        throw new AppError(
          "unavailable",
          "视频组件版本未验证，需要 FFmpeg/ffprobe 8.0.1；未修改现有组件。",
        );
    }
    const directory = await mkdtemp(join(tmpdir(), "aster-video-"));
    try {
      signal.throwIfAborted();
      const file = join(
        directory,
        format === "mov" ? "input.mp4" : "input.webm",
      );
      await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
      const input = [
        "-v",
        "error",
        "-max_alloc",
        "33554432",
        "-protocol_whitelist",
        "file,pipe",
        "-f",
        format,
        ...(format === "mov"
          ? ["-enable_drefs", "0", "-use_absolute_path", "0"]
          : []),
        "-i",
        file,
      ];
      const raw = await this.run(
        ffprobe,
        [
          ...input,
          "-show_entries",
          "stream=codec_type,width,height:format=duration",
          "-of",
          "json",
        ],
        signal,
        65536,
      );
      const info = metadata.safeParse(JSON.parse(raw.toString("utf8")));
      if (!info.success)
        throw new AppError("invalid_input", "视频流信息或尺寸不受支持。");
      const video = info.data.streams.find(
        (stream) => stream.codec_type === "video",
      );
      if (
        !video?.width ||
        !video.height ||
        video.width * video.height > 16777216
      )
        throw new AppError(
          "invalid_input",
          "视频没有可读取的画面，或尺寸超过 1600 万像素。",
        );
      const duration =
        info.data.format.duration === undefined
          ? null
          : Number(info.data.format.duration) * 1000;
      const durationMs =
        duration !== null && Number.isFinite(duration)
          ? Math.round(duration)
          : null;
      if (durationMs !== null && (durationMs < 0 || durationMs > 86400000))
        throw new AppError("capacity", "视频时长超过可读取范围。");
      if (operation.action === "video.info")
        return videoResultSchema.parse({
          action: operation.action,
          width: video.width,
          height: video.height,
          durationMs,
          hasAudio: info.data.streams.some(
            (stream) => stream.codec_type === "audio",
          ),
        });
      if (durationMs !== null && operation.timeMs >= durationMs)
        throw new AppError("invalid_input", "请求时间不在视频时长内。");
      const frameFile = join(directory, "frame.jpg");
      // Keep the last presentation frame at or before the requested point. Seeking with -ss
      // discards a held low-frame-rate frame and can incorrectly return the next scene.
      await this.run(
        ffmpeg,
        [
          "-nostdin",
          "-threads",
          "1",
          ...input,
          "-map",
          "0:v:0",
          "-an",
          "-sn",
          "-dn",
          "-vf",
          `setpts=PTS-STARTPTS,trim=end=${(operation.timeMs + 1) / 1000},select=lte(t\\,${operation.timeMs / 1000}),scale=w=min(1600\\,iw):h=min(1600\\,ih):force_original_aspect_ratio=decrease:out_range=full:out_color_matrix=bt601,format=yuvj420p`,
          "-fps_mode",
          "passthrough",
          "-enc_time_base",
          "filter",
          "-threads",
          "1",
          "-c:v",
          "mjpeg",
          "-q:v",
          "3",
          "-f",
          "image2",
          "-update",
          "1",
          frameFile,
        ],
        signal,
        65536,
      );
      const sizeOnDisk = await stat(frameFile).catch(() => null);
      if (!sizeOnDisk?.isFile())
        throw new AppError("invalid_input", "这个时间没有可解码画面。");
      if (sizeOnDisk.size > 3 * 1024 * 1024)
        throw new AppError("capacity", "视频画面超过 3 MiB 输出限制。");
      const image = await readFile(frameFile);
      if (!image.length)
        throw new AppError(
          "invalid_input",
          "这个时间没有可解码画面，请检查视频时长。",
        );
      const size = imageSize(image);
      signal.throwIfAborted();
      return videoResultSchema.parse({
        action: operation.action,
        requestedMs: operation.timeMs,
        durationMs,
        selection: "last-frame-at-or-before",
        width: size.width,
        height: size.height,
        mime: "image/jpeg",
        image: image.toString("base64"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  private run(
    binary: string,
    args: string[],
    signal: AbortSignal,
    maxBytes: number,
  ): Promise<Buffer> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      const chunks: Buffer[] = [];
      let bytes = 0,
        diagnostics = 0;
      let failure: Error | undefined, killing: Promise<void> | undefined;
      const stop = () => {
        if (killing || !child.pid) return;
        if (process.platform === "win32") {
          killing = new Promise<void>((done) => {
            const killer = spawn(
              "taskkill",
              ["/PID", String(child.pid), "/T", "/F"],
              { windowsHide: true, stdio: "ignore" },
            );
            const timer = setTimeout(() => {
              killer.kill();
              child.kill();
            }, 5000);
            killer.once("error", () => {
              child.kill();
            });
            killer.once("close", () => {
              clearTimeout(timer);
              done();
            });
          });
        } else {
          child.kill("SIGKILL");
          killing = Promise.resolve();
        }
      };
      const abort = () => {
        failure =
          signal.reason instanceof Error &&
          signal.reason.name === "TimeoutError"
            ? new AppError(
                "unavailable",
                "视频读取超过 20 秒，已停止解码；可读取较早时间点或较短视频。",
              )
            : signal.reason instanceof Error
              ? signal.reason
              : new DOMException("视频读取已取消。", "AbortError");
        stop();
      };
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          failure = new AppError("capacity", "视频解码输出超过限制。");
          stop();
        } else chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        diagnostics += chunk.length;
        if (diagnostics > 65536) {
          failure = new AppError("capacity", "视频解码诊断超过限制。");
          stop();
        }
      });
      child.once("error", () => {
        failure = new AppError(
          "unavailable",
          "无法启动视频组件，请提供已验证的 FFmpeg/ffprobe 8.0.1。",
        );
      });
      child.once("close", (code) => {
        signal.removeEventListener("abort", abort);
        void Promise.resolve(killing).then(() => {
          if (failure) reject(failure);
          else if (signal.aborted) reject(signal.reason);
          else if (code !== 0)
            reject(
              new AppError(
                "invalid_input",
                "视频无法解码，格式可能损坏或不受支持。",
              ),
            );
          else resolve(Buffer.concat(chunks));
        });
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
