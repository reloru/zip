const BLOCK = 512;
const MAX_OCTAL_SIZE = 0o77777777777;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function writeString(buf, offset, length, str) {
  const bytes = encoder.encode(str);
  buf.set(bytes.subarray(0, length), offset);
}

function writeOctal(buf, offset, length, value) {
  const str = Math.floor(value).toString(8).padStart(length - 1, "0");
  writeString(buf, offset, length - 1, str);
}

function truncateUtf8(str, maxBytes) {
  let bytes = encoder.encode(str);
  if (bytes.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const bodyLength = encoder.encode(body).length;
  const digits = String(bodyLength).length;
  let length = bodyLength + digits;
  if (String(length).length !== digits) length = bodyLength + String(length).length;
  return `${length}${body}`;
}

function header({ name, size, mtime, type, mode }) {
  const buf = new Uint8Array(BLOCK);
  writeString(buf, 0, 100, name);
  writeOctal(buf, 100, 8, mode);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeOctal(buf, 124, 12, Math.min(size, MAX_OCTAL_SIZE));
  writeOctal(buf, 136, 12, mtime);
  buf.fill(0x20, 148, 156);
  writeString(buf, 156, 1, type);
  writeString(buf, 257, 6, "ustar\0");
  writeString(buf, 263, 2, "00");
  let sum = 0;
  for (const b of buf) sum += b;
  writeString(buf, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return buf;
}

function headerBlocks(path, size, mtime, isDir) {
  const name = isDir && !path.endsWith("/") ? path + "/" : path;
  const nameBytes = encoder.encode(name).length;
  const needsPax = nameBytes > 100 || /[^\x20-\x7e]/.test(name) || size > MAX_OCTAL_SIZE;
  const blocks = [];
  if (needsPax) {
    let pax = paxRecord("path", name);
    if (size > MAX_OCTAL_SIZE) pax += paxRecord("size", String(size));
    const paxBytes = encoder.encode(pax);
    blocks.push(header({
      name: truncateUtf8("PaxHeader/" + name.replace(/[^\x20-\x7e]/g, "_"), 100),
      size: paxBytes.length, mtime, type: "x", mode: 0o644
    }));
    blocks.push(padded(paxBytes));
  }
  blocks.push(header({
    name: truncateUtf8(name.replace(/[^\x20-\x7e]/g, "_"), 100),
    size: isDir ? 0 : size, mtime, type: isDir ? "5" : "0", mode: isDir ? 0o755 : 0o644
  }));
  return blocks;
}

function padded(bytes) {
  const out = new Uint8Array(Math.ceil(bytes.length / BLOCK) * BLOCK);
  out.set(bytes);
  return out;
}

/**
 * Builds a tar stream from items: { path, file?: Blob, dir?: boolean, mtime?: number(ms) }.
 * onBytes(n) is called as file content is emitted.
 */
export function createTarStream(items, onBytes = () => {}) {
  let index = 0;
  let reader = null;
  let pending = 0;
  return new ReadableStream({
    async pull(controller) {
      if (reader) {
        const { done, value } = await reader.read();
        if (!done) {
          controller.enqueue(value);
          onBytes(value.length);
          return;
        }
        reader = null;
        if (pending % BLOCK) controller.enqueue(new Uint8Array(BLOCK - (pending % BLOCK)));
        return;
      }
      if (index >= items.length) {
        controller.enqueue(new Uint8Array(BLOCK * 2));
        controller.close();
        return;
      }
      const item = items[index++];
      const isDir = !!item.dir;
      const size = isDir ? 0 : item.file.size;
      const mtime = Math.floor((item.mtime ?? Date.now()) / 1000);
      for (const block of headerBlocks(item.path, size, mtime, isDir)) controller.enqueue(block);
      if (!isDir && size > 0) {
        reader = item.file.stream().getReader();
        pending = size;
      }
    },
    cancel() {
      if (reader) reader.cancel();
    }
  }, { highWaterMark: 0 });
}

function readString(bytes, offset, length) {
  let end = offset;
  while (end < offset + length && bytes[end] !== 0) end++;
  return decoder.decode(bytes.subarray(offset, end));
}

function readNumber(bytes, offset, length) {
  if (bytes[offset] & 0x80) {
    let value = bytes[offset] & 0x7f;
    for (let i = offset + 1; i < offset + length; i++) value = value * 256 + bytes[i];
    return value;
  }
  const str = readString(bytes, offset, length).trim();
  return str ? parseInt(str, 8) : 0;
}

function parsePax(bytes) {
  const out = {};
  let i = 0;
  while (i < bytes.length) {
    let sp = i;
    while (sp < bytes.length && bytes[sp] !== 0x20) sp++;
    const len = parseInt(decoder.decode(bytes.subarray(i, sp)), 10);
    if (!len || len <= 0) break;
    const record = decoder.decode(bytes.subarray(sp + 1, i + len - 1));
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

function checksumOk(bytes) {
  const stored = readNumber(bytes, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : bytes[i];
  return stored === sum;
}

export async function isTar(blob) {
  if (blob.size < BLOCK) return false;
  const bytes = new Uint8Array(await blob.slice(0, BLOCK).arrayBuffer());
  return readString(bytes, 257, 5) === "ustar" || checksumOk(bytes);
}

/**
 * Parses a tar Blob without copying it. Returns [{ path, size, dir, mtime, blob }].
 */
export async function readTar(blob) {
  const entries = [];
  let offset = 0;
  let paxNext = null;
  let longName = null;
  while (offset + BLOCK <= blob.size) {
    const bytes = new Uint8Array(await blob.slice(offset, offset + BLOCK).arrayBuffer());
    if (bytes.every(b => b === 0)) break;
    if (!checksumOk(bytes)) throw new Error("Corrupt tar header at byte " + offset);
    const type = String.fromCharCode(bytes[156] || 0x30);
    let size = readNumber(bytes, 124, 12);
    const dataStart = offset + BLOCK;
    const next = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x" || type === "g") {
      const pax = parsePax(new Uint8Array(await blob.slice(dataStart, dataStart + size).arrayBuffer()));
      if (type === "x") paxNext = pax;
      offset = next;
      continue;
    }
    if (type === "L") {
      longName = readString(new Uint8Array(await blob.slice(dataStart, dataStart + size).arrayBuffer()), 0, size);
      offset = next;
      continue;
    }

    let path = readString(bytes, 0, 100);
    if (readString(bytes, 257, 5) === "ustar") {
      const prefix = readString(bytes, 345, 155);
      if (prefix) path = prefix + "/" + path;
    }
    if (longName) path = longName;
    if (paxNext?.path) path = paxNext.path;
    if (paxNext?.size) size = parseInt(paxNext.size, 10);
    const mtime = (paxNext?.mtime ? parseFloat(paxNext.mtime) : readNumber(bytes, 136, 12)) * 1000;
    paxNext = null;
    longName = null;

    const realNext = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "0" || type === "\0" || type === "7") {
      entries.push({ path, size, dir: false, mtime, blob: blob.slice(dataStart, dataStart + size) });
    } else if (type === "5") {
      entries.push({ path, size: 0, dir: true, mtime });
    }
    offset = realNext;
  }
  return entries;
}
