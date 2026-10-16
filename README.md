# Zip

A web app that creates and extracts archives entirely in the browser. Files are never uploaded.

**Create**
- ZIP (no compression, fast, normal or maximum), TAR.GZ or TAR, from files or whole folders (drag and drop, or pick them)
- Optional ZIP password with **AES-256** (WinZip AE-2, strong) or **ZipCrypto** (legacy: opens in almost any tool but is easily cracked)
- Optional "save straight to disk" in Chromium browsers, so very large archives don't have to fit in memory

**Extract**
- `.zip` (including AES and ZipCrypto password protected), `.tar`, `.tar.gz` / `.tgz`, `.gz`
- Download single files, download everything, or (in Chromium browsers) save the whole tree into a folder
- Convert TAR archives to ZIP, or re-save a password-protected ZIP without its password
- Archives with paths that try to escape the destination folder (`../`, absolute paths) are refused (ZIP) or sanitized (TAR)

**On phones**
- Installable (Add to Home Screen) and works offline after the first visit (service worker in `sw.js`)
- Outputs open a card with **Download** and **Share / Save to Files** (Web Share API), instead of surprise downloads
- "Save all files" hands every extracted file to the share sheet in one go (e.g. iOS "Save to Files")
- Sticky bottom action bar, 44px+ touch targets, safe-area insets for notched screens, touch-specific wording

Note: ZIP encryption covers file contents, not file names. Some built-in OS unzip tools can't open AES-encrypted ZIPs; 7-Zip, WinZip, Keka and The Unarchiver can.

## Stack

Static files with no build step: `index.html`, `style.css`, `app.js`, `tar.js`, `sw.js`, `manifest.webmanifest`, `icons/` (a small tar reader/writer with PAX long-name support) and the vendored [zip.js](https://github.com/gildas-lormeau/zip.js) 2.23.0 bundle in `vendor/` (BSD-3-Clause). Gzip uses the browser's built-in `CompressionStream`.

## Hosting

GitHub Pages: Settings → Pages → Source "Deploy from a branch" → `main` / root. `.nojekyll` disables Jekyll processing. When changing app files, bump `CACHE` in `sw.js` so installed copies refresh promptly (they also refresh in the background on each visit).

To run locally: `python3 -m http.server` in this folder, then open http://localhost:8000.
