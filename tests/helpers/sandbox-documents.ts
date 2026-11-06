import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { samplePdf } from "./pdf.js";
import { sampleWord } from "./office.js";
import { sampleVideo } from "./video.js";

/** Independent binary fixtures exercise Python's installed parsers inside the actual VM. */
export async function sandboxDocuments(
  directory: string,
  endpoint: { port: number; token: string },
  conversationId: string,
  checksum: string,
) {
  const media = await sampleVideo(directory);
  const files = [
    {
      id: randomUUID(),
      name: "document.pdf",
      bytes: samplePdf(checksum, "SCAN_PROOF"),
    },
    { id: randomUUID(), name: "document.docx", bytes: sampleWord(checksum) },
    { id: randomUUID(), name: "clip.mp4", bytes: media.bytes },
  ];
  for (const file of files) {
    const response = await fetch(
      `http://127.0.0.1:${endpoint.port}/attachments/upload`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
          "x-file-name": file.name,
          "x-attachment-id": file.id,
          "x-conversation-id": conversationId,
        },
        body: new Uint8Array(file.bytes),
      },
    );
    assert.equal(response.status, 200);
  }
  const command = `python3 - <<'PY'
import pypdfium2 as pdfium,docx,av,xlrd
pdf=pdfium.PdfDocument('/inputs/${files[0]!.id}.pdf')
assert '${checksum}' in pdf[0].get_textpage().get_text_range()
pdf[1].render(scale=1).to_pil().save('/workspace/page.png')
w=docx.Document('/inputs/${files[1]!.id}.docx')
assert '${checksum}' in '\\n'.join(p.text for p in w.paragraphs)
with av.open('/inputs/${files[2]!.id}.mp4') as video:
 frames=list(video.decode(video=0))
 assert len(frames)>=2
 image=frames[-1].to_image()
 r,g,b=image.getpixel((10,10))
 assert b>200 and r<40 and g<40
 image.save('/workspace/video.png')
print('PDF_WORD_VIDEO_OK')
PY`;
  return { ids: files.map((file) => file.id), command };
}
