# Third-party notices

AttendWell's own code is under the MIT licence (`LICENSE`). These parts come from other people,
ship inside the organiser app and keep their own licences. The iPad app (`ipad/`) has no
third-party code: it uses only Apple system frameworks and the system SQLite library.

## Electron

The organiser app runs on Electron 44.9.3 (MIT, Copyright (c) Electron contributors and GitHub Inc.).
Electron includes Chromium and Node.js and their own dependencies, each under its own licence.
Every packaged build carries Electron's `LICENSE` and `LICENSES.chromium.html` beside the app.
https://github.com/electron/electron

## cloudflared

The organiser app runs `cloudflared` as a separate program to open the Cloudflare quick tunnel. It is
not linked into AttendWell. It is downloaded at build time from the pinned release, checked against the
SHA-256 values in `desktop/third-party/cloudflared.json`, and shipped in the app's resources folder
(`cloudflared/<platform>/cloudflared`, or `cloudflared.exe` on Windows) with its licence text.

- Version 2026.10.1, Apache License 2.0, Copyright Cloudflare, Inc.
- https://github.com/cloudflare/cloudflared

## Bun

The register service (`attendwell-service`) is compiled with `bun build --compile`, so each copy
contains the Bun runtime. Bun is MIT-licensed, and it embeds JavaScriptCore (LGPL-2.0) and other
components listed at https://bun.sh/docs/project/licensing. The build used Bun 1.3.10.

## npm packages bundled into the app

These are bundled into the organiser app's interface, or into the interface the register service
serves, by electron-vite and Vite. Versions are pinned in `package.json`, `desktop/package.json` and the
lock files. Licence texts are in each package's repository.

| Package | Version | Licence |
|---|---|---|
| react | 18.3.1 | MIT |
| react-dom | 18.3.1 | MIT |
| scheduler (used by react-dom) | 0.23.2 | MIT |
| lucide-react | 0.576.0 | ISC |
| tailwindcss (CSS output, register interface) | 4.1.18 | MIT |
| qrcode | 1.5.4 | MIT |
| dijkstrajs (used by qrcode) | 1.0.3 | MIT |
| @app-patterns/commands | 0.4.1 | MIT |
| @app-patterns/settings | 0.4.1 | MIT |
| @app-patterns/settings-electron | 0.4.1 | MIT |
| @app-patterns/settings-react | 0.4.1 | MIT |
| @app-patterns/updates | 0.4.1 | MIT |
| @app-patterns/updates-react | 0.4.1 | MIT |

The `@app-patterns/*` packages are by the same author and are vendored as tarballs in
`desktop/vendor/app-patterns/`.

Build tools (electron-builder, electron-vite, Vite, TypeScript, Playwright and others)
are used to build AttendWell and are not part of the shipped app.
