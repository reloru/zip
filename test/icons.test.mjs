import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";

const SITE = "https://reloru.github.io/zip/";
const fileUrl = (path) => new URL(`../${path}`, import.meta.url);
const html = readFileSync(fileUrl("index.html"), "utf8");
const manifest = JSON.parse(readFileSync(fileUrl("manifest.webmanifest"), "utf8"));
const sw = readFileSync(fileUrl("sw.js"), "utf8");

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const links = (rel) => [...html.matchAll(/<link\b[^>]*>/g)].map((m) => attrs(m[0])).filter((a) => a.rel === rel);
const metas = () => [...html.matchAll(/<meta\b[^>]*>/g)].map((m) => attrs(m[0]));
const og = (property) => metas().find((a) => a.property === property)?.content;

/** Reads width, height and alpha-ness from a PNG buffer. Alpha means an alpha channel or a tRNS chunk. */
function png(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "PNG signature");
  const colorType = buf[25];
  let hasTrns = false;
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at);
    if (buf.toString("latin1", at + 4, at + 8) === "tRNS") hasTrns = true;
    at += 12 + length;
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), alpha: colorType === 4 || colorType === 6 || hasTrns };
}

const fromSite = (path) => {
  assert.ok(!path.startsWith("/") && !/^[a-z]+:/i.test(path), `${path} is relative, so it works under /zip/`);
  assert.ok(existsSync(fileUrl(path)), `${path} exists`);
  return png(readFileSync(fileUrl(path)));
};

test("apple-touch-icon is a 180x180 opaque PNG inlined as a data: URI", () => {
  const [link, ...rest] = links("apple-touch-icon");
  assert.equal(rest.length, 0);
  assert.equal(link.sizes, "180x180");
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(link.href);
  assert.ok(match, "href is a base64 PNG data: URI");
  const info = png(Buffer.from(match[1], "base64"));
  assert.deepEqual([info.width, info.height, info.alpha], [180, 180, false]);
});

test("tab icons are opaque PNGs whose files match their declared sizes", () => {
  const tab = links("icon");
  assert.ok(tab.length > 0);
  for (const link of tab) {
    assert.equal(link.type, "image/png", link.href);
    const { width, height, alpha } = fromSite(link.href);
    assert.equal(link.sizes, `${width}x${height}`, link.href);
    assert.equal(alpha, false, link.href);
  }
});

test("og:image is an absolute 512px opaque PNG on the live site with matching width and height", () => {
  const url = og("og:image");
  assert.ok(url.startsWith(SITE), url);
  const { width, height, alpha } = fromSite(url.slice(SITE.length));
  assert.deepEqual([width, height, alpha], [512, 512, false]);
  assert.equal(og("og:image:type"), "image/png");
  assert.equal(og("og:image:width"), String(width));
  assert.equal(og("og:image:height"), String(height));
  assert.ok(og("og:image:alt"));
});

test("manifest icons are opaque PNGs: 192 and 512 for any, plus a separate maskable", () => {
  const key = (i) => `${i.sizes} ${i.purpose}`;
  assert.deepEqual(manifest.icons.map(key).sort(), ["192x192 any", "512x512 any", "512x512 maskable"]);
  for (const icon of manifest.icons) {
    assert.equal(icon.type, "image/png", icon.src);
    const { width, height, alpha } = fromSite(icon.src);
    assert.equal(icon.sizes, `${width}x${height}`, icon.src);
    assert.equal(alpha, false, icon.src);
  }
  const maskable = manifest.icons.find((i) => i.purpose === "maskable");
  assert.notEqual(maskable.src, manifest.icons.find((i) => i.sizes === "512x512" && i.purpose === "any").src);
});

test("no SVG app icons: head, manifest, or icon directory", () => {
  const iconRefs = [...links("icon"), ...links("apple-touch-icon"), ...links("mask-icon")].map((a) => `${a.type ?? ""} ${a.href}`);
  for (const ref of [...iconRefs, og("og:image"), ...manifest.icons.map((i) => `${i.type} ${i.src}`)]) {
    assert.ok(!/svg/i.test(ref.slice(0, 60)), ref.slice(0, 60));
  }
  assert.deepEqual(readdirSync(fileUrl("icons")).filter((f) => /\.svg$/i.test(f)), []);
});

test("every file the service worker precaches exists", () => {
  const list = JSON.parse(/const ASSETS = (\[[\s\S]*?\]);/.exec(sw)[1]);
  for (const path of list) if (path !== "./") assert.ok(existsSync(fileUrl(path)), path);
  for (const icon of manifest.icons) assert.ok(list.includes(icon.src), `${icon.src} is precached`);
});
