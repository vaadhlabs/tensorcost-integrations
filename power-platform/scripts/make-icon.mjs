// Writes TensorCost/icon.png: a 256x256 dark square with a light T. Node
// built-ins only, so the icon can be rebuilt with nothing installed.
// Power Platform wants a PNG between 1 KB and 1 MB, square, no transparency.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../TensorCost/icon.png');
const SIZE = 256;
const BACKGROUND = [31, 41, 55];
const FOREGROUND = [245, 247, 250];

const rowBytes = SIZE * 4 + 1;
const raw = Buffer.alloc(rowBytes * SIZE);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const bar = y >= 64 && y < 96 && x >= 56 && x < 200;
    const stem = x >= 112 && x < 144 && y >= 64 && y < 200;
    const c = bar || stem ? FOREGROUND : BACKGROUND;
    const o = y * rowBytes + 1 + x * 4;
    raw[o] = c[0];
    raw[o + 1] = c[1];
    raw[o + 2] = c[2];
    raw[o + 3] = 255;
  }
}

const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA

fs.writeFileSync(
  OUT,
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);
console.log(`wrote ${OUT}`);
