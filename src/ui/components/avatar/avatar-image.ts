import { imageSize } from "image-size";
import { maxAvatarBytes } from "../../../shared/avatar.js";
let activeDecodes = 0;

/** The caller owns the returned bitmap and must close it, including stale results. */
export async function readAvatarSource(file: File): Promise<ImageBitmap> {
  if (activeDecodes >= 2) throw Error("图片解码仍在结束，请稍后再试。");
  activeDecodes++;
  try {
    if (file.size > 25 * 1024 * 1024) throw Error("源图片最多 25 MiB。");
    const header = imageSize(
      new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer()),
    );
    if (
      !["png", "jpg", "webp", "gif", "bmp"].includes(header.type ?? "") ||
      header.width < 1 ||
      header.height < 1 ||
      header.width * header.height > 20_000_000
    )
      throw Error(
        "请选择不超过 2,000 万像素的 PNG、JPEG、WebP、GIF 或 BMP 图片。",
      );
    try {
      return await createImageBitmap(file);
    } catch {
      throw Error("图片内容无法完整解码，请选择有效的图片。");
    }
  } finally {
    activeDecodes--;
  }
}
export function encodeAvatarCanvas(surface: HTMLCanvasElement) {
  const url = surface.toDataURL("image/webp", 0.88);
  if (!url.startsWith("data:image/webp;base64,"))
    throw Error("当前环境无法编码 WebP 头像。");
  const data = url.slice("data:image/webp;base64,".length);
  if (atob(data).length > maxAvatarBytes)
    throw Error("裁剪结果超过 64 KiB，请选择更简单的图片。");
  return data;
}
