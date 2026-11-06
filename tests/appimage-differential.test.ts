import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createServer,
  request,
  type IncomingMessage,
  type RequestOptions,
  type ClientRequest,
} from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { test } from "node:test";
import { CancellationToken, HttpExecutor } from "builder-util-runtime";
import { FileWithEmbeddedBlockMapDifferentialDownloader } from "electron-updater/out/differentialDownloader/FileWithEmbeddedBlockMapDifferentialDownloader.js";

class NodeHttpExecutor extends HttpExecutor<ClientRequest> {
  createRequest(
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) {
    return request(options, callback);
  }
}

function fixture(blocks: Buffer[]) {
  const map = deflateRawSync(
    Buffer.from(
      JSON.stringify({
        version: "2",
        files: [
          {
            name: "file",
            offset: 0,
            sizes: blocks.map((block) => block.length),
            checksums: blocks.map((block) =>
              createHash("sha256").update(block).digest("base64"),
            ),
          },
        ],
      }),
    ),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(map.length);
  return {
    bytes: Buffer.concat([...blocks, map, length]),
    blockMapSize: map.length,
  };
}

void test("the installed updater reconstructs embedded-blockmap packages using only changed single ranges and verifies SHA-512", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-differential-"));
  const blocks = [
    Buffer.alloc(32_768, 1),
    Buffer.alloc(32_768, 2),
    Buffer.alloc(32_768, 3),
  ];
  const oldImage = fixture(blocks);
  const newImage = fixture([blocks[0]!, Buffer.alloc(32_768, 4), blocks[2]!]);
  let downloaded = 0;
  let corrupt = false;
  const ranges: string[] = [];
  const server = createServer((incoming, response) => {
    const range = incoming.headers.range ?? "";
    ranges.push(range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) {
      response.writeHead(416);
      response.end();
      return;
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    const bytes = Buffer.from(newImage.bytes.subarray(start, end + 1));
    downloaded += bytes.length;
    if (corrupt && start === 32_768) bytes[0] = 99;
    response.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${newImage.bytes.length}`,
      "Content-Length": bytes.length,
      "Accept-Ranges": "bytes",
    });
    response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const token = new CancellationToken();
  try {
    await writeFile(join(directory, "old.AppImage"), oldImage.bytes);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const logs: string[] = [];
    const download = () =>
      new FileWithEmbeddedBlockMapDifferentialDownloader(
        {
          size: newImage.bytes.length,
          blockMapSize: newImage.blockMapSize,
          sha512: createHash("sha512").update(newImage.bytes).digest("base64"),
        },
        new NodeHttpExecutor(),
        {
          oldFile: join(directory, "old.AppImage"),
          newFile: join(directory, "new.AppImage"),
          newUrl: new URL(`http://127.0.0.1:${address.port}/new.AppImage`),
          isUseMultipleRangeRequest: false,
          requestHeaders: null,
          cancellationToken: token,
          logger: {
            info: (message) => logs.push(String(message)),
            warn: () => undefined,
            error: () => undefined,
          },
        },
      ).download();
    await download();
    assert.deepEqual(
      await readFile(join(directory, "new.AppImage")),
      newImage.bytes,
    );
    assert.ok(
      downloaded < newImage.bytes.length / 2,
      `${downloaded} / ${newImage.bytes.length}`,
    );
    assert.ok(ranges.every((range) => !range.includes(",")));
    assert.ok(logs.some((message) => message.includes("To download:")));
    corrupt = true;
    await assert.rejects(download(), /sha512|checksum/i);
  } finally {
    token.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
