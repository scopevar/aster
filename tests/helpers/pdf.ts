import { deflateSync } from "node:zlib";
import { createCanvas } from "@napi-rs/canvas";

/** Independently authored PDF fixture: selectable text on page one, only raster pixels on page two. */
export function samplePdf(proof: string, scanned: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(proof + scanned))
    throw Error("ASCII fixture labels required");
  const canvas = createCanvas(600, 400),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 600, 400);
  ctx.fillStyle = "black";
  ctx.font = "bold 40px sans-serif";
  ctx.fillText(scanned, 24, 58);
  ctx.font = 'bold 52px "Microsoft YaHei"';
  ctx.fillText("中文识别", 24, 128);
  ctx.fillStyle = "#0000ff";
  ctx.beginPath();
  ctx.moveTo(180, 150);
  ctx.lineTo(80, 330);
  ctx.lineTo(280, 330);
  ctx.closePath();
  ctx.fill();
  const pixels = ctx.getImageData(0, 0, 600, 400).data,
    rgb = Buffer.alloc(600 * 400 * 3);
  for (let i = 0; i < 600 * 400; i++) {
    rgb[i * 3] = pixels[i * 4]!;
    rgb[i * 3 + 1] = pixels[i * 4 + 1]!;
    rgb[i * 3 + 2] = pixels[i * 4 + 2]!;
  }
  const stream = (bytes: Buffer, extra = "") =>
    Buffer.concat([
      Buffer.from(`<< /Length ${bytes.length} ${extra} >>\nstream\n`),
      bytes,
      Buffer.from("\nendstream"),
    ]);
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    ),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    stream(
      Buffer.from(
        `BT /F1 22 Tf 30 320 Td (${proof}) Tj ET\n0.2 0.5 0.8 rg 60 50 200 150 re f`,
      ),
    ),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << /XObject << /Im1 8 0 R >> >> /Contents 7 0 R >>",
    ),
    stream(Buffer.from("q 600 0 0 400 0 0 cm /Im1 Do Q")),
    stream(
      deflateSync(rgb),
      "/Type /XObject /Subtype /Image /Width 600 /Height 400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode",
    ),
  ];
  const chunks = [Buffer.from("%PDF-1.7\n")],
    offsets = [0];
  let length = chunks[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const bytes = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(bytes);
    length += bytes.length;
  });
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(chunks);
}
