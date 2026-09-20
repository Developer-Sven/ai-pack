# Security floors for Next.js, React Server Components, Vite and sharp

Verified 2026-09-18 against the vendor advisories linked below. New advisories arrive monthly. Before trusting
this table, re-check https://nextjs.org/blog, https://github.com/vercel/next.js/security/advisories and
https://github.com/facebook/react/security/advisories.

## How to check a project

```bash
npm ls next react react-dom react-server-dom-webpack react-server-dom-turbopack react-server-dom-parcel vite sharp
npm audit --omit=dev            # CI: add --audit-level=high
npm view next dist-tags --json  # latest (16.x) and backport (15.5.x)
```

Next.js ships its own compiled copy of the RSC runtime, so the `next` version is what counts for Next apps.
The standalone `react-server-dom-*` packages matter for RSC outside Next (Vite RSC plugin, Parcel, React Router RSC).

## Next.js (App Router unless noted)

| Date | ID | Severity | Issue | Fixed in |
|---|---|---|---|---|
| 2025-03 | CVE-2025-29927 | Critical 9.1 | Middleware authorization bypass via `x-middleware-subrequest` | 12.3.5, 13.5.9, 14.2.25, 15.2.3 |
| 2025-12-03 | CVE-2025-66478 (React CVE-2025-55182, "React2Shell") | Critical 10.0 | RCE via RSC protocol deserialization | 15.0.5, 15.1.9, 15.2.6, 15.3.6, 15.4.8, 15.5.7, 16.0.7 |
| 2025-12-11 | CVE-2025-55184 + CVE-2025-67779 (complete fix) | High | RSC DoS (infinite loop) | 14.2.35, 15.0.7, 15.1.11, 15.2.8, 15.3.8, 15.4.10, 15.5.9, 16.0.10 |
| 2025-12-11 | CVE-2025-55183 | Medium | Server Function source-code exposure (secrets inlined in code leak) | same as above |
| 2026-07-21 | CVE-2026-64641 | High | DoS via crafted Server Action requests | 16.2.11, 15.5.21 |
| 2026-07-21 | CVE-2026-64642 | High | Middleware/Proxy bypass (Turbopack build + single `i18n.locales` entry) | 16.2.11, 15.5.21 |
| 2026-07-21 | CVE-2026-64645 | High | SSRF / open redirect in `rewrites()`/`redirects()` with request-derived destination host | 16.2.11, 15.5.21 |
| 2026-07-21 | CVE-2026-64649 | High | SSRF in Server Actions on custom servers (Host-header control) | 16.2.11, 15.5.21 |
| 2026-07-21 | CVE-2026-64643 / -64644 / -64646 / -64647 / -64648 | Medium | Action/`use cache` endpoint-ID disclosure; SVG image DoS; Edge action payload DoS; `fetch` cache confusion (2x) | 16.2.11, 15.5.21 |
| 2026-08-25 | GHSA-2xp9-vwfh-vxw4 (libheif CVE-2026-84383) | Critical | Unauthenticated RCE when `/_next/image` optimizes an attacker-controlled AVIF | **16.3.3, 15.5.24** |
| 2026-08-25 | CVE-2026-75604 / GHSA-p293-qw3h-jr36 | Critical 9.0 | Unauthenticated RCE on **Windows-hosted** servers (Pages + App Router without Cache Components); 13.4 to 15.5.23, 16.0 to 16.3.2 | **16.3.3, 15.5.24** |

**Floor today: `next >= 16.3.3` or `>= 15.5.24`.** The August fixes were only released for 16.3 and 15.5, so
16.0, 16.1 and 16.2 must move to 16.3.x. 14.x and older get no 2026 fixes. React2Shell: an app that was online
and unpatched after 2025-12-04 should have all its secrets rotated.
`npx fix-react2shell-next` only covers the December 2025 advisories.

## React Server Components packages (`react-server-dom-webpack|turbopack|parcel`)

| Date | CVE | Issue | Patched |
|---|---|---|---|
| 2025-12-03 | CVE-2025-55182 | RCE (React2Shell) | 19.0.1, 19.1.2, 19.2.1 |
| 2025-12-11 | CVE-2025-55184 / CVE-2025-67779 / CVE-2025-55183 | DoS, source exposure | 19.0.3, 19.1.4, 19.2.3 |
| 2026-01-26 | CVE-2026-23864 | DoS (earlier fixes incomplete) | 19.0.4, 19.1.5, 19.2.4 |
| 2026-04-08 | CVE-2026-23869 | DoS (CPU) | 19.0.5, 19.1.6, 19.2.5 |
| 2026-05-06 | CVE-2026-23870 | DoS (memory/CPU) | 19.0.6, 19.1.7, 19.2.6 |
| 2026-07-21 | CVE-2026-44907 | DoS in Server Functions | **19.0.8, 19.1.9, 19.2.8** (19.3.0 is later) |

Client-only React apps (Vite SPA, no RSC or Server Functions) are not affected by these.

## Vite dev server (also relevant to Next-free React apps)

These only bite when the dev server is reachable from the network (`vite --host`, `server.host: true`, Docker).
On Windows hosts, CVE-2026-53571 applies to NTFS and 8.3 short names.

| Date | CVE / GHSA | Issue | Patched |
|---|---|---|---|
| 2025 (Apr–Oct) | GHSA-xcj6-pq6g-qj4x, -356w-63v5-8wf4, -859w-5945-r5v3, -93m4-6634-74q7 | `server.fs.deny` bypasses (`.svg`, invalid request-target, `/./`, `\` on Windows) | latest 6.x/7.x |
| 2026-04-06 | CVE-2026-39363 (GHSA-p9ff-h696-f583) | Arbitrary file read via the HMR WebSocket `fetchModule` | 8.0.5, 7.3.2, 6.4.2 |
| 2026-04-06 | GHSA-v2wj-q39q-566r, GHSA-4w7w-66w2-5vf9 | `fs.deny` bypass with queries; path traversal in optimized-deps `.map` | same line or newer |
| 2026-06-01 | CVE-2026-53571 (GHSA-fx2h-pf6j-xcff) | `fs.deny` bypass via NTFS ADS (`/.env::$DATA?raw`) and 8.3 names on Windows | **8.0.16, 7.3.5, 6.4.3** |

**Floor: `vite >= 8.0.16`, `7.3.5` or `6.4.3`.** Vite 5.x stopped at 5.4.21 (2025-10), so upgrade it.
Never set `server.allowedHosts: true` (DNS rebinding) or `envPrefix: ''`.

## sharp / libheif (any Node code that decodes untrusted images)

CVE-2026-84383 (2026-08-25, CVSS 9.8) is a heap overflow in libheif 1.22.0 to 1.23.1 when decoding crafted
HEIC/HEIF/AVIF files. `sharp@0.35.4` bundles `sharp-libvips` 1.3.3 with libheif 1.23.2, so **use sharp >= 0.35.4**
wherever user uploads or remote images get decoded (Discord bots, upload endpoints, image proxies).
