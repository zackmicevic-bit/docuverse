# DocuVerse desktop builds (Tauri v2) — .dmg (macOS) + .msi/.exe (Windows)

The installers themselves must be compiled on real hardware (or CI runners):
a Mac for `.dmg`, Windows for `.msi`/NSIS `.exe`. This folder is the recipe
and config — the web app in `src/` + `index.html` + `main.pjs` is the frontend.

Product: **DocuVerse** · Gumroad permalink `ltsmdc` (`https://gumroad.com/l/ltsmdc`)
· 1 seat per key · icon source: `src/icon.png` (2024px master) / `src/icon-512.png`.

## 0. Prereqs

- Rust stable: https://rustup.rs
- Node 18+ with **pnpm**: `npm i -g pnpm`
- macOS: Xcode CLT (`xcode-select --install`). For universal arm64+x86_64 add
  the Intel target: `rustup target add x86_64-apple-darwin`
- Windows: WebView2 (preinstalled on Win10 1803+), Visual Studio Build Tools
  with the C++ workload.

## 1. Scaffold the shell (once, on your machine)

```sh
cd src/tools/desktop
pnpm install
# Rust plugins (the exact commands you listed):
cargo add tauri-plugin-store
cargo add tauri-plugin-http
# JS bindings (already in package.json, but harmless to re-run):
pnpm add @tauri-apps/plugin-store @tauri-apps/plugin-http
```

## 2. Icons (once)

```sh
cd src/tools/desktop
pnpm dlx tauri icon ../../../src/icon.png   # writes src-tauri/icons/{.icns,.ico,.png}
```

(`tauri.conf.json` already points at those paths. Apple shows transparency as
black on Home Screen — the logo has a solid dark background, so it is fine.)

## 3. Export the frontend into `dist/`

Save/publish the generator, then copy the shipped files:

```sh
cd src/tools/desktop
rm -rf dist && mkdir dist
cp ../../index.html dist/
cp ../../main.pjs dist/      # harmless; the shell boots index.html
cp -r ../../src dist/src
```

(`index.html` is the `<body>` fragment Perchance wraps — for the desktop shell
serve it as-is; the app boots `src/app.js` as a module. No secrets are
embedded: the Gumroad check sends only the public permalink + customer key.)

## 4. Build

```sh
cd src/tools/desktop
# macOS Apple Silicon .dmg:
pnpm tauri build --target aarch64-apple-darwin --bundles dmg
# macOS Intel .dmg (on the same Mac):
pnpm tauri build --target x86_64-apple-darwin --bundles dmg
# Universal .dmg (lipo-merge the two app bundles, then hdiutil — or ship both):
# Windows (on Windows) NSIS .exe + .msi:
pnpm tauri build --target x86_64-pc-windows-msvc --bundles nsis,msi
```

Artifacts land in `src-tauri/target/<triple>/release/bundle/{dmg,nsis,msi}/`.

## 5. Signing (required for clean installs)

- macOS: sign + notarize or Gatekeeper will block it —
  `APPLE_SIGNING_IDENTITY`, then `xcrun notarytool submit … --wait`.
- Windows: sign the `.exe`/`.msi` with an EV/code-signing cert or SmartScreen
  will warn.

## 6. Licensing notes (Option A, already implemented in `src/license.js`)

- First launch shows the Activate modal; the key is verified once against
  `POST https://api.gumroad.com/v2/licenses/verify`
  (`product_permalink=ltsmdc`, `increment_uses_count=true`) and cached in
  `localStorage` (`docuverse.license.v1`) for 30 days of offline use.
- Silent re-checks use `increment_uses_count=false` (no seat consumed).
- Seat limit 1: activation refuses keys already showing >1 use — reset uses
  in Gumroad (Customers → sale → reset uses) for reinstalls.
- `LICENSE.enforceOnWeb` in `src/license.js` gates the web build too; set it
  to `false` to only gate desktop shells and leave perchance.org open.
- Client-side checks are bypassable — treat as casual licensing, not DRM.
