import { mkdir, rm, writeFile } from "node:fs/promises";
import sharp from "sharp";

// hicolor 的 apps 目录只登记这些尺寸。electron-builder 按文件名装进对应目录。
const linuxIconSizes = [16, 22, 24, 32, 36, 48, 64, 72, 96, 128, 192, 256, 512];

/** Convert the supplied original into deterministic application resources. */
export async function buildIcons() {
  const source = "assets/aster-icon.png";
  // Native icon slots have fixed sizes; source padding must not shrink the artwork.
  const artwork = await sharp(source).trim({ threshold: 0 }).png().toBuffer();
  const icon = (size) => {
    const padding = Math.max(1, Math.round(size / 16));
    return sharp(artwork)
      .resize(size - padding * 2, size - padding * 2, {
        fit: "contain",
        background: "#00000000",
      })
      .extend({
        top: padding,
        bottom: padding,
        left: padding,
        right: padding,
        background: "#00000000",
      })
      .png();
  };
  const renderer = "dist/renderer/assets";
  const desktop = "dist/desktop/assets";
  const linuxIcons = "build/icons";
  await Promise.all(
    [renderer, desktop, linuxIcons].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  await Promise.all([
    mkdir(renderer, { recursive: true }),
    mkdir(desktop, { recursive: true }),
    mkdir(linuxIcons, { recursive: true }),
  ]);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = await Promise.all(sizes.map((size) => icon(size).toBuffer()));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (const [index, size] of sizes.entries()) {
    const image = images[index];
    if (!image) throw new Error("Missing icon representation");
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  }
  await Promise.all([
    writeFile(`${desktop}/aster.ico`, Buffer.concat([header, ...images])),
    icon(256).toFile(`${renderer}/aster-avatar.png`),
    icon(256).toFile(`${desktop}/aster-app.png`),
    icon(16).toFile(`${desktop}/aster-tray.png`),
    icon(32).toFile(`${desktop}/aster-tray@2x.png`),
    ...linuxIconSizes.map((size) =>
      icon(size).toFile(`${linuxIcons}/${size}x${size}.png`),
    ),
  ]);
}
