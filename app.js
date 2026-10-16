import { createTarStream, readTar, isTar } from "./tar.js";

const zip = window.zip;
zip.configure({ useWebWorkers: true });

const $ = (sel) => document.querySelector(sel);
const LIST_LIMIT = 500;
const MIME = { zip: "application/zip", "tar.gz": "application/gzip", tar: "application/x-tar" };
const isTouch = matchMedia("(hover: none) and (pointer: coarse)").matches;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 2 : 1)) + " " + units[i];
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

function safePath(path) {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s && s !== "." && s !== "..")
    .map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "_"))
    .join("/");
}

function baseName(path) {
  const parts = safePath(path).split("/");
  return parts[parts.length - 1] || "file";
}

function splitPath(path) {
  const clean = path.replace(/\/+$/, "");
  const slash = clean.lastIndexOf("/");
  return slash < 0 ? { name: clean, dir: "" } : { name: clean.slice(slash + 1), dir: clean.slice(0, slash) };
}

function pathMeta(path, { isDir = false, prefix = "" } = {}) {
  const { name, dir } = splitPath(path);
  return el("span", { class: "meta", title: path },
    el("span", { class: "fname" }, prefix + (isDir ? name + "/" : name)),
    dir ? el("span", { class: "dirname" }, dir + "/") : null
  );
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function toFile(blob, name) {
  return blob instanceof File && blob.name === name ? blob : new File([blob], name, { type: blob.type || "application/octet-stream" });
}

function canShare(files) {
  try {
    return !!navigator.canShare && navigator.canShare({ files });
  } catch {
    return false;
  }
}

const canShareAny = () => canShare([new File([""], "a.txt", { type: "text/plain" })]);

async function share(files, onError) {
  try {
    await navigator.share({ files });
  } catch (e) {
    if (!isAbort(e)) onError(e.name === "NotAllowedError" ? "Your browser blocked sharing. Use Download instead." : friendlyError(e));
  }
}

function isAbort(error) {
  return error && (error.name === "AbortError" || error === "abort" || error?.message === "abort");
}

function friendlyError(error, encrypted) {
  const msg = error?.message || String(error);
  if (msg === zip.ERR_INVALID_PASSWORD) return "Wrong password.";
  if (encrypted && (msg === zip.ERR_INVALID_CRC32 || msg === zip.ERR_INVALID_COMPRESSED_DATA || msg === zip.ERR_INVALID_AUTHENTICATION_CODE)) {
    return "Wrong password, or the archive is damaged.";
  }
  if (msg === zip.ERR_EOCDR_NOT_FOUND || msg === zip.ERR_BAD_FORMAT) return "This file is not a valid ZIP archive, or it is damaged or incomplete.";
  if (msg === zip.ERR_UNSAFE_FILENAME) return "This archive was refused because it contains file paths (such as \"../\" or absolute paths) that could write files outside the folder you extract to.";
  if (msg === zip.ERR_UNSUPPORTED_ENCRYPTION) return "This archive uses an encryption method that is not supported.";
  if (msg === zip.ERR_UNSUPPORTED_COMPRESSION) return "This archive uses a compression method that is not supported.";
  if (error?.name === "NotReadableError") return "The file could not be read. It may have been moved, or your browser lost access to it. Add it again.";
  if (error?.name === "QuotaExceededError" || /out of memory|allocation failed/i.test(msg)) return "Your device ran out of memory or storage. Try fewer or smaller files.";
  return msg;
}

/**
 * A card for one or more produced files: Download (single file) and, where the browser supports it,
 * Share / Save to Files. Returns { node, release }; release() frees the object URL.
 */
function outputCard({ title, lines = [], files, onError }) {
  const urls = [];
  const buttons = [];
  if (files.length === 1) {
    const url = URL.createObjectURL(files[0]);
    urls.push(url);
    buttons.push(el("a", { class: "primary", href: url, download: files[0].name }, "Download"));
  }
  if (canShare(files)) {
    const label = isIOS
      ? (files.length === 1 ? "Share / Save to Files" : `Save ${files.length} files to Files`)
      : (files.length === 1 ? "Share" : `Share ${files.length} files`);
    buttons.push(el("button", { type: "button", class: files.length === 1 ? "btn share-btn" : "primary share-btn", onclick: () => share(files, onError) }, label));
  }
  const node = el("div", {},
    el("p", { class: "ok" }, title),
    ...lines.map((l) => el("p", { class: "muted" }, l)),
    buttons.length ? el("div", { class: "row" }, ...buttons) : null
  );
  return { node, release: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
}

function reveal(node) {
  if (isTouch) requestAnimationFrame(() => node.scrollIntoView({ behavior: "smooth", block: "nearest" }));
}

function setProgress(box, fraction, text) {
  box.hidden = false;
  box.querySelector(".bar span").style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  box.querySelector(".progress-text").textContent = text;
}

function throttle(fn, ms = 100) {
  let last = 0;
  return (...args) => {
    const now = performance.now();
    if (now - last >= ms) { last = now; fn(...args); }
  };
}

async function openOutput(filename, mime, toDisk) {
  if (toDisk && window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({ suggestedName: filename });
    const writable = await handle.createWritable();
    return { writable, finish: async () => null, abort: () => writable.abort().catch(() => {}) };
  }
  const ts = new TransformStream();
  const blobPromise = new Response(ts.readable).blob().then((b) => new Blob([b], { type: mime }));
  blobPromise.catch(() => {});
  return { writable: ts.writable, finish: () => blobPromise, abort: () => {} };
}

/* ---------- Tabs ---------- */

const tabs = [$("#tab-create"), $("#tab-extract")];
for (const tab of tabs) {
  tab.addEventListener("click", () => {
    for (const t of tabs) {
      const selected = t === tab;
      t.setAttribute("aria-selected", String(selected));
      $("#" + t.getAttribute("aria-controls")).hidden = !selected;
    }
  });
}

function wireDrop(zone, onDrop) {
  let depth = 0;
  zone.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; zone.classList.add("over"); });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); });
  zone.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; zone.classList.remove("over"); } });
  zone.addEventListener("drop", (e) => { e.preventDefault(); depth = 0; zone.classList.remove("over"); onDrop(e.dataTransfer); });
}
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

/* ---------- Create ---------- */

const items = [];
const itemPaths = new Set();
let createController = null;
let createCard = null;

function uniquePath(path) {
  if (!itemPaths.has(path)) return path;
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let n = 2;
  while (itemPaths.has(`${dir}${stem} (${n})${ext}`)) n++;
  return `${dir}${stem} (${n})${ext}`;
}

function addItem(path, file, dir = false) {
  const clean = safePath(path);
  if (!clean) return;
  const finalPath = dir ? clean : uniquePath(clean);
  if (dir && itemPaths.has(finalPath)) return;
  itemPaths.add(finalPath);
  items.push({ path: finalPath, file, dir, mtime: file?.lastModified ?? Date.now() });
}

function removeItem(index) {
  itemPaths.delete(items[index].path);
  items.splice(index, 1);
  renderCreateList();
}

function renderCreateList() {
  const list = $("#create-list");
  list.replaceChildren();
  $("#create-list-wrap").hidden = items.length === 0;
  const files = items.filter((i) => !i.dir);
  const total = files.reduce((s, i) => s + i.file.size, 0);
  $("#create-btn").disabled = items.length === 0 || !!createController;
  $("#create-btn").textContent = items.length ? `Create archive · ${formatBytes(total)}` : "Create archive";
  $("#create-summary").textContent = `${plural(files.length, "file")} · ${formatBytes(total)}`;
  items.slice(0, LIST_LIMIT).forEach((item, index) => {
    list.append(el("li", { class: item.dir ? "dir" : "" },
      pathMeta(item.path, { isDir: item.dir }),
      el("span", { class: "size" }, item.dir ? "folder" : formatBytes(item.file.size)),
      el("button", { type: "button", class: "icon-btn", "aria-label": `Remove ${item.path}`, disabled: !!createController, onclick: () => removeItem(index) }, "×")
    ));
  });
  if (items.length > LIST_LIMIT) list.append(el("li", { class: "more" }, `and ${items.length - LIST_LIMIT} more`));
}

async function readDirectoryEntry(entry, prefix) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    addItem(prefix + entry.name, file);
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  const children = [];
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    children.push(...batch);
  }
  const path = prefix + entry.name;
  if (!children.length) addItem(path, null, true);
  for (const child of children) await readDirectoryEntry(child, path + "/");
}

async function addFromDataTransfer(dt) {
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) {
    for (const entry of entries) await readDirectoryEntry(entry, "");
  } else {
    for (const file of dt.files) addItem(file.name, file);
  }
  renderCreateList();
}

$("#file-input").addEventListener("change", (e) => {
  for (const file of e.target.files) addItem(file.name, file);
  e.target.value = "";
  renderCreateList();
});
$("#folder-input").addEventListener("change", (e) => {
  for (const file of e.target.files) addItem(file.webkitRelativePath || file.name, file);
  e.target.value = "";
  renderCreateList();
});
if (!("webkitdirectory" in document.createElement("input")) || isIOS || /Android/.test(navigator.userAgent)) {
  $("#folder-label").hidden = true;
}
wireDrop($("#create-drop"), addFromDataTransfer);
$("#clear-btn").addEventListener("click", () => { items.length = 0; itemPaths.clear(); renderCreateList(); });

const format = () => document.querySelector('input[name="format"]:checked').value;

function updateOptions() {
  const fmt = format();
  const isZip = fmt === "zip";
  $("#ext-label").textContent = "." + fmt;
  for (const node of document.querySelectorAll(".zip-only")) node.hidden = !isZip;
  for (const node of document.querySelectorAll(".tar-only")) node.hidden = isZip;
  const enc = $("#encryption").value;
  const hint = $("#enc-hint");
  hint.classList.toggle("warn", enc === "zipcrypto");
  hint.textContent = enc === "aes"
    ? "AES-256 is strong. Some built-in unzip tools (for example Windows File Explorer, macOS Archive Utility or the iPhone Files app) may not open it; 7-Zip, WinZip, Keka, The Unarchiver and this site can. File names stay visible; only file contents are encrypted."
    : "ZipCrypto opens almost everywhere but can be cracked with free tools. Use it only for compatibility, not for sensitive files. File names stay visible.";
}
for (const r of document.querySelectorAll('input[name="format"]')) r.addEventListener("change", updateOptions);
$("#encryption").addEventListener("change", updateOptions);
updateOptions();

$("#pw-toggle").addEventListener("click", (e) => {
  const show = $("#password").type === "password";
  $("#password").type = $("#password-confirm").type = show ? "text" : "password";
  e.target.textContent = show ? "Hide" : "Show";
  e.target.setAttribute("aria-pressed", String(show));
});
$("#password").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#password-confirm").focus(); } });
for (const id of ["#password-confirm", "#archive-name"]) {
  $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
}

if (window.showSaveFilePicker && !isTouch) $("#save-picker-row").hidden = false;

function showCreateResult(...nodes) {
  createCard?.release();
  createCard = null;
  $("#create-result").replaceChildren(...nodes);
}

async function createArchive() {
  const fmt = format();
  const password = fmt === "zip" ? $("#password").value : "";
  if (password && password !== $("#password-confirm").value) {
    showCreateResult(el("p", { class: "error" }, "The passwords do not match."));
    reveal($("#create-result"));
    return;
  }
  const name = (safePath($("#archive-name").value.trim()).replace(/\//g, "_") || "archive") + "." + fmt;
  const files = items.filter((i) => !i.dir);
  const totalBytes = files.reduce((s, i) => s + i.file.size, 0);

  let out;
  try {
    out = await openOutput(name, MIME[fmt], $("#save-picker").checked && !$("#save-picker-row").hidden);
  } catch (e) {
    if (!isAbort(e)) showCreateResult(el("p", { class: "error" }, friendlyError(e)));
    return;
  }

  createController = new AbortController();
  const { signal } = createController;
  document.activeElement?.blur?.();
  $("#create-cancel").hidden = false;
  showCreateResult();
  renderCreateList();

  const box = $("#create-progress");
  const report = throttle((done) => setProgress(box, totalBytes ? done / totalBytes : 1, `${formatBytes(done)} of ${formatBytes(totalBytes)}`));
  setProgress(box, 0, "Starting…");
  const started = performance.now();

  try {
    if (fmt === "zip") {
      const writer = new zip.ZipWriter(out.writable, {
        level: Number($("#level").value),
        password: password || undefined,
        encryptionStrength: 3,
        zipCrypto: !!password && $("#encryption").value === "zipcrypto",
        signal
      });
      const progress = new Map();
      const sum = () => { let s = 0; for (const v of progress.values()) s += v; return s; };
      await Promise.all(items.map((item, i) => item.dir
        ? writer.add(item.path + "/", null, { directory: true, lastModDate: new Date(item.mtime), signal })
        : writer.add(item.path, new zip.BlobReader(item.file), {
            lastModDate: new Date(item.mtime),
            signal,
            onprogress: (p) => { progress.set(i, p); report(sum()); },
            onend: () => { progress.set(i, item.file.size); report(sum()); }
          })
      ));
      await writer.close();
    } else {
      let done = 0;
      let stream = createTarStream(items, (n) => { done += n; report(done); });
      if (fmt === "tar.gz") stream = stream.pipeThrough(new CompressionStream("gzip"));
      await stream.pipeTo(out.writable, { signal });
    }

    const blob = await out.finish();
    box.hidden = true;
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    if (blob) {
      const pct = totalBytes ? Math.round((1 - blob.size / totalBytes) * 100) : 0;
      const enc = password ? ` · ${$("#encryption").value === "aes" ? "AES-256" : "ZipCrypto"} encrypted` : "";
      const card = outputCard({
        title: `${name} is ready`,
        lines: [`${formatBytes(totalBytes)} → ${formatBytes(blob.size)}${pct > 0 ? ` (${pct}% smaller)` : ""}${enc} · ${seconds} s`],
        files: [toFile(blob, name)],
        onError: (m) => $("#create-result").append(el("p", { class: "error" }, m))
      });
      showCreateResult(card.node);
      createCard = card;
      if (!isTouch) triggerDownload(blob, name);
    } else {
      showCreateResult(el("p", { class: "ok" }, `${name} saved`), el("p", { class: "muted" }, `Saved to the location you chose · ${seconds} s`));
    }
    reveal($("#create-result"));
  } catch (e) {
    out.abort();
    box.hidden = true;
    const cancelled = isAbort(e) || signal.aborted;
    showCreateResult(el("p", { class: cancelled ? "muted" : "error" }, cancelled ? "Cancelled." : friendlyError(e)));
    reveal($("#create-result"));
  } finally {
    createController = null;
    $("#create-cancel").hidden = true;
    renderCreateList();
  }
}

$("#create-btn").addEventListener("click", createArchive);
$("#create-cancel").addEventListener("click", () => createController?.abort());

/* ---------- Extract ---------- */

let archive = null;
let extractController = null;
let extractCard = null;

async function detectFormat(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (head[0] === 0x50 && head[1] === 0x4b && [3, 5, 7].includes(head[2])) return "zip";
  if (head[0] === 0x1f && head[1] === 0x8b) return "gzip";
  if (await isTar(file)) return "tar";
  if (/\.zip$/i.test(file.name)) return "zip";
  return null;
}

function gunzipName(name) {
  return name.replace(/\.tgz$/i, ".tar").replace(/\.gz$/i, "") || "file";
}

function showInfo(...nodes) { $("#extract-info").replaceChildren(...nodes); }

function showExtractResult(...nodes) {
  extractCard?.release();
  extractCard = null;
  $("#extract-result").replaceChildren(...nodes);
  if (nodes.length) reveal($("#extract-result"));
}

function extractError(message) {
  showExtractResult(el("p", { class: "error" }, message));
}

function resetExtract() {
  archive?.reader?.close().catch(() => {});
  archive = null;
  $("#unlock-form").hidden = true;
  $("#unlock-error").textContent = "";
  $("#extract-password").value = "";
  $("#extract-actions").hidden = true;
  $("#extract-list-wrap").hidden = true;
  $("#extract-progress").hidden = true;
  $("#extract-bar").hidden = true;
  showInfo();
  showExtractResult();
}

async function openArchive(file) {
  if (!file) return;
  extractController?.abort();
  resetExtract();
  showInfo(el("p", { class: "muted" }, `Reading ${file.name}…`));
  try {
    const kind = await detectFormat(file);
    let entries;
    let reader = null;
    let label;
    if (kind === "zip") {
      reader = new zip.ZipReader(new zip.BlobReader(file));
      const zipEntries = await reader.getEntries();
      entries = zipEntries.map((e) => ({
        path: e.filename, size: e.uncompressedSize, dir: e.directory, encrypted: e.encrypted, zipCrypto: e.zipCrypto, zipEntry: e, mtime: e.lastModDate?.getTime()
      }));
      label = "ZIP";
    } else if (kind === "gzip") {
      const inflated = await new Response(file.stream().pipeThrough(new DecompressionStream("gzip"))).blob();
      if (await isTar(inflated)) {
        entries = await readTar(inflated);
        label = "TAR.GZ";
      } else {
        entries = [{ path: gunzipName(file.name), size: inflated.size, dir: false, blob: inflated }];
        label = "GZIP";
      }
    } else if (kind === "tar") {
      entries = await readTar(file);
      label = "TAR";
    } else {
      showInfo(el("p", { class: "error" }, "Unsupported file. This site extracts .zip, .tar, .tar.gz, .tgz and .gz archives."));
      return;
    }

    const encryptedFiles = entries.filter((e) => e.encrypted && !e.dir);
    archive = {
      file, kind, label, reader, entries,
      encrypted: encryptedFiles.length > 0,
      method: encryptedFiles.length ? (encryptedFiles.every((e) => e.zipCrypto) ? "ZipCrypto" : "AES") : null,
      password: null,
      unlocked: encryptedFiles.length === 0
    };

    const fileEntries = entries.filter((e) => !e.dir);
    const total = fileEntries.reduce((s, e) => s + (e.size || 0), 0);
    showInfo(
      el("p", { class: "name" }, file.name),
      el("p", { class: "muted" }, `${label} · ${plural(fileEntries.length, "file")} · ${formatBytes(file.size)} → ${formatBytes(total)}${archive.encrypted ? ` · ${archive.method} encrypted` : ""}`)
    );
    $("#unlock-form").hidden = !archive.encrypted;
    if (archive.encrypted && !isTouch) $("#extract-password").focus();

    $("#save-folder-btn").hidden = !window.showDirectoryPicker || isTouch;
    $("#download-all-btn").textContent = isTouch && canShareAny() ? "Save all files" : "Download all";
    $("#download-all-btn").hidden = fileEntries.length < 2;
    $("#convert-btn").hidden = kind === "zip" && !archive.encrypted;
    $("#convert-btn").textContent = archive.encrypted ? "Save as ZIP without password" : "Convert to ZIP";
    $("#extract-actions").hidden = $("#save-folder-btn").hidden && $("#download-all-btn").hidden && $("#convert-btn").hidden;
    renderExtractList();
  } catch (e) {
    showInfo(el("p", { class: "error" }, friendlyError(e)));
  }
}

function renderExtractList() {
  const list = $("#extract-list");
  list.replaceChildren();
  if (!archive) return;
  const locked = !archive.unlocked;
  const busy = !!extractController;
  for (const id of ["#save-folder-btn", "#download-all-btn", "#convert-btn"]) $(id).disabled = locked || busy;
  $("#extract-cancel").hidden = !busy;
  $("#extract-bar").hidden = !busy;
  const files = archive.entries.filter((e) => !e.dir);
  const folders = new Set();
  for (const e of archive.entries) {
    const dir = e.dir ? e.path.replace(/\/+$/, "") : splitPath(e.path).dir;
    if (dir) folders.add(dir);
  }
  $("#extract-list-wrap").hidden = files.length === 0;
  $("#extract-summary").textContent = plural(files.length, "file") + (folders.size ? ` in ${plural(folders.size, "folder")}` : "");
  files.slice(0, LIST_LIMIT).forEach((entry) => {
    list.append(el("li", {},
      pathMeta(entry.path, { prefix: entry.encrypted && locked ? "🔒 " : "" }),
      el("span", { class: "size" }, formatBytes(entry.size)),
      el("button", {
        type: "button", class: "icon-btn", "aria-label": `Download ${entry.path}`, title: "Download",
        disabled: (entry.encrypted && locked) || busy, onclick: () => extractOne(entry)
      }, "↓")
    ));
  });
  if (files.length > LIST_LIMIT) list.append(el("li", { class: "more" }, `and ${files.length - LIST_LIMIT} more`));
}

function entryOptions(entry, extra = {}) {
  return { password: entry.encrypted ? archive.password : undefined, ...extra };
}

async function entryBlob(entry, extra) {
  if (entry.blob) return entry.blob;
  return entry.zipEntry.getData(new zip.BlobWriter(), entryOptions(entry, extra));
}

async function writeEntry(entry, writable, extra) {
  if (entry.blob) return entry.blob.stream().pipeTo(writable, { signal: extra?.signal });
  return entry.zipEntry.getData(writable, entryOptions(entry, extra));
}

$("#unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = $("#extract-password").value;
  const errorBox = $("#unlock-error");
  errorBox.textContent = "";
  if (!password) { errorBox.textContent = "Enter the password."; return; }
  const target = archive.entries.find((x) => x.encrypted && !x.dir);
  try {
    await target.zipEntry.getData(new zip.BlobWriter(), { password, checkPasswordOnly: true });
    archive.password = password;
    archive.unlocked = true;
    $("#extract-password").blur();
    $("#unlock-form").hidden = true;
    $("#extract-info").append(el("p", { class: "ok" }, "Unlocked"));
    renderExtractList();
  } catch (err) {
    errorBox.textContent = friendlyError(err, true);
  }
});

async function runExtractTask(task) {
  extractController = new AbortController();
  showExtractResult();
  renderExtractList();
  const box = $("#extract-progress");
  try {
    await task(extractController.signal, box);
  } catch (e) {
    if (!isAbort(e) && !extractController.signal.aborted) extractError(friendlyError(e, archive?.encrypted));
    else showExtractResult(el("p", { class: "muted" }, "Cancelled."));
  } finally {
    box.hidden = true;
    extractController = null;
    renderExtractList();
  }
}

function showFilesCard(title, lines, files) {
  const card = outputCard({ title, lines, files, onError: (m) => $("#extract-result").append(el("p", { class: "error" }, m)) });
  showExtractResult(card.node);
  extractCard = card;
}

function extractOne(entry) {
  return runExtractTask(async (signal, box) => {
    const name = baseName(entry.path);
    const report = throttle((p, t) => setProgress(box, t ? p / t : 1, `${name}: ${formatBytes(t ? entry.size * (p / t) : 0)} of ${formatBytes(entry.size)}`));
    setProgress(box, 0, `Extracting ${name}…`);
    const blob = await entryBlob(entry, { signal, onprogress: report });
    showFilesCard(`${name} is ready`, [formatBytes(blob.size)], [toFile(blob, name)]);
    if (!isTouch) triggerDownload(blob, name);
  });
}

function makeBatchReporter(box, files) {
  const total = files.reduce((s, e) => s + (e.size || 0), 0);
  let done = 0;
  const show = throttle((current) => setProgress(box, total ? (done + current) / total : 1, `${formatBytes(done + current)} of ${formatBytes(total)}`));
  return {
    track: (entry) => (p, t) => show(t ? (entry.size || 0) * (p / t) : 0),
    finish: (entry) => { done += entry.size || 0; show(0); }
  };
}

$("#save-folder-btn").addEventListener("click", async () => {
  let root;
  try {
    root = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (e) {
    if (!isAbort(e)) extractError(friendlyError(e));
    return;
  }
  await runExtractTask(async (signal, box) => {
    const dirs = new Map([["", root]]);
    const getDir = async (path) => {
      if (dirs.has(path)) return dirs.get(path);
      const slash = path.lastIndexOf("/");
      const parent = await getDir(slash < 0 ? "" : path.slice(0, slash));
      const handle = await parent.getDirectoryHandle(path.slice(slash + 1), { create: true });
      dirs.set(path, handle);
      return handle;
    };
    const files = archive.entries.filter((e) => !e.dir);
    const batch = makeBatchReporter(box, files);
    setProgress(box, 0, "Extracting…");
    for (const entry of archive.entries) {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const path = safePath(entry.path);
      if (!path) continue;
      if (entry.dir) { await getDir(path); continue; }
      const slash = path.lastIndexOf("/");
      const dir = await getDir(slash < 0 ? "" : path.slice(0, slash));
      const handle = await dir.getFileHandle(path.slice(slash + 1), { create: true });
      const writable = await handle.createWritable();
      try {
        await writeEntry(entry, writable, { signal, onprogress: batch.track(entry) });
      } catch (e) {
        await writable.abort().catch(() => {});
        throw e;
      }
      batch.finish(entry);
    }
    showExtractResult(el("p", { class: "ok" }, `Saved ${plural(files.length, "file")} to “${root.name}”`));
  });
});

$("#download-all-btn").addEventListener("click", () => {
  const files = archive.entries.filter((e) => !e.dir);
  const sharing = isTouch && canShareAny();
  if (!sharing && files.length > 10 && !confirm(`This will start ${files.length} separate downloads. Your browser may ask you to allow multiple downloads. Continue?`)) return;
  return runExtractTask(async (signal, box) => {
    const batch = makeBatchReporter(box, files);
    setProgress(box, 0, "Extracting…");
    const out = [];
    for (const entry of files) {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const blob = await entryBlob(entry, { signal, onprogress: batch.track(entry) });
      batch.finish(entry);
      if (sharing) {
        out.push(toFile(blob, baseName(entry.path)));
      } else {
        triggerDownload(blob, baseName(entry.path));
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (sharing && canShare(out)) {
      showFilesCard(`${plural(out.length, "file")} ready`, ["Folders are not kept when saving this way. To keep them, use Convert to ZIP."], out);
    } else if (sharing) {
      for (const f of out) { triggerDownload(f, f.name); await new Promise((r) => setTimeout(r, 300)); }
      showExtractResult(el("p", { class: "ok" }, `Downloaded ${plural(out.length, "file")}`));
    } else {
      showExtractResult(el("p", { class: "ok" }, `Downloaded ${plural(files.length, "file")}`));
    }
  });
});

$("#convert-btn").addEventListener("click", () => runExtractTask(async (signal, box) => {
  const name = archive.file.name.replace(/\.(zip|tar\.gz|tgz|tar|gz)$/i, "") + (archive.encrypted ? "-unlocked" : "") + ".zip";
  const files = archive.entries.filter((e) => !e.dir);
  const batch = makeBatchReporter(box, files);
  const out = await openOutput(name, MIME.zip, false);
  const writer = new zip.ZipWriter(out.writable, { level: 5, signal });
  setProgress(box, 0, "Converting…");
  try {
    for (const entry of archive.entries) {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const path = safePath(entry.path);
      if (!path) continue;
      const lastModDate = entry.mtime ? new Date(entry.mtime) : new Date();
      if (entry.dir) { await writer.add(path + "/", null, { directory: true, lastModDate }); continue; }
      const blob = await entryBlob(entry, { signal, onprogress: batch.track(entry) });
      await writer.add(path, new zip.BlobReader(blob), { lastModDate, signal });
      batch.finish(entry);
    }
    await writer.close();
  } catch (e) {
    out.abort();
    throw e;
  }
  const blob = await out.finish();
  showFilesCard(`${name} is ready`, [formatBytes(blob.size)], [toFile(blob, name)]);
  if (!isTouch) triggerDownload(blob, name);
}));

$("#extract-cancel").addEventListener("click", () => extractController?.abort());
$("#archive-input").addEventListener("change", (e) => { openArchive(e.target.files[0]); e.target.value = ""; });
wireDrop($("#extract-drop"), (dt) => openArchive(dt.files[0]));

renderCreateList();
