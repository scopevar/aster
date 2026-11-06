import { crc32, deflateRawSync } from "node:zlib";
import { createCanvas } from "@napi-rs/canvas";

/** Independently authored ZIP/OOXML fixtures, not the production converter's writer. */
export function officeZip(entries: Record<string, string | Buffer>) {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [path, value] of Object.entries(entries)) {
    const name = Buffer.from(path),
      data = Buffer.isBuffer(value) ? value : Buffer.from(value),
      compressed = deflateRawSync(data),
      checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const xml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const relNamespace =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const docNamespace =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export function sampleWord(token: string, imageToken = "WORD_IMAGE") {
  const canvas = createCanvas(460, 230),
    context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 460, 230);
  context.fillStyle = "#0000ff";
  context.fillRect(35, 95, 105, 105);
  context.fillStyle = "black";
  context.font = "23px sans-serif";
  context.fillText(imageToken, 18, 50);
  return officeZip({
    "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<Relationships xmlns="${relNamespace}"><Relationship Id="root" Type="${docNamespace}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<Relationships xmlns="${relNamespace}"><Relationship Id="evil" Type="${docNamespace}/hyperlink" Target="javascript:alert(1)" TargetMode="External"/><Relationship Id="image" Type="${docNamespace}/image" Target="media/proof.png"/></Relationships>`,
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${docNamespace}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>${xml(token)}</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>中文文档</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:hyperlink r:id="evil"><w:r><w:t>不安全链接</w:t></w:r></w:hyperlink></w:p><w:p><w:r><w:drawing><wp:inline><wp:extent cx="4380000" cy="2190000"/><wp:docPr id="1" name="proof" descr="验收图形"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="proof"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="image"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>`,
    "word/media/proof.png": canvas.toBuffer("image/png"),
  });
}
export function sampleWorkbook(token: string, rows = 3) {
  const namespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const textCell = (address: string, value: string) =>
    `<c r="${address}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
  let data = `<row r="1">${textCell("A1", "校验词")}${textCell("B1", "数量")}${textCell("C1", "结果")}</row><row r="2">${textCell("A2", token)}<c r="B2"><v>0</v></c><c r="C2"><f>SUM(B2,42)</f><v>42</v></c></row><row r="3">${textCell("A3", "逗号,保留")}${textCell("B3", "第一行\n第二行")}<c r="C3"><f>1+2</f></c></row>`;
  for (let row = 4; row <= rows; row++)
    data += `<row r="${row}">${textCell(`A${row}`, `记录 ${row}`)}<c r="B${row}"><v>${row}</v></c></row>`;
  return officeZip({
    "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    "_rels/.rels": `<Relationships xmlns="${relNamespace}"><Relationship Id="root" Type="${docNamespace}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<workbook xmlns="${namespace}" xmlns:r="${docNamespace}"><sheets><sheet name="数据" sheetId="1" r:id="sheet1"/><sheet name="明细" sheetId="2" r:id="sheet2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="${relNamespace}"><Relationship Id="sheet1" Type="${docNamespace}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="sheet2" Type="${docNamespace}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="${namespace}"><dimension ref="A1:C${rows}"/><sheetData>${data}</sheetData></worksheet>`,
    "xl/worksheets/sheet2.xml": `<worksheet xmlns="${namespace}"><sheetData><row r="1">${textCell("A1", "第二张表")}</row><row r="2">${textCell("A2", token + "_SECOND")}</row></sheetData></worksheet>`,
  });
}
