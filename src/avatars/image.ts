import sharp from "sharp";
import { createHash } from "node:crypto";
import { maxAvatarBytes } from "../shared/avatar.js";
import { AppError } from "../shared/core.js";

/** Only this decoder can construct pixels validated for avatar storage. */
export class ValidatedAvatar {
  private constructor(
    readonly bytes: Uint8Array,
    readonly hash: string,
  ) {}
  static async decode(base64: string): Promise<ValidatedAvatar> {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length > maxAvatarBytes || bytes.toString("base64") !== base64)
      throw new AppError("invalid_input", "头像编码无效或超过 64 KiB。");
    const decoder = sharp(bytes, {
      limitInputPixels: 256 * 256,
      failOn: "warning",
      animated: false,
    }).timeout({ seconds: 2 });
    try {
      const meta = await decoder.metadata();
      if (
        meta.format !== "webp" ||
        meta.width !== 256 ||
        meta.height !== 256 ||
        (meta.pages ?? 1) !== 1
      )
        throw Error("Unsupported avatar dimensions");
      await decoder.raw().toBuffer();
      return new ValidatedAvatar(
        bytes,
        createHash("sha256").update(bytes).digest("hex"),
      );
    } catch {
      throw new AppError(
        "invalid_input",
        "头像必须是完整、静态的 256×256 WebP 图片。",
      );
    } finally {
      decoder.destroy();
    }
  }

  static async fromImage(bytes: Uint8Array): Promise<ValidatedAvatar> {
    if (!bytes.length || bytes.length > 10 * 1024 * 1024)
      throw new AppError("invalid_input", "图片为空或超过 10 MiB。");
    const decoder = sharp(bytes, {
      limitInputPixels: 4096 * 4096,
      failOn: "warning",
      animated: false,
    }).timeout({ seconds: 3 });
    try {
      const meta = await decoder.metadata();
      if (
        !meta.width ||
        !meta.height ||
        !["jpeg", "png", "webp"].includes(meta.format ?? "") ||
        (meta.pages ?? 1) !== 1
      )
        throw Error("Unsupported remote avatar");
      for (const quality of [82, 70, 58, 46, 34]) {
        const encoded = await sharp(bytes, {
          limitInputPixels: 4096 * 4096,
          failOn: "warning",
          animated: false,
        })
          .timeout({ seconds: 3 })
          .rotate()
          .resize(256, 256, { fit: "cover" })
          .webp({ quality })
          .toBuffer();
        if (encoded.length <= maxAvatarBytes)
          return ValidatedAvatar.decode(encoded.toString("base64"));
      }
      throw Error("Remote avatar could not fit storage limit");
    } catch {
      throw new AppError(
        "invalid_input",
        "图片必须是可解码的静态 PNG、JPEG 或 WebP 图片。",
      );
    } finally {
      decoder.destroy();
    }
  }
}
