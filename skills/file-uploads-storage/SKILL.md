---
name: file-uploads-storage
description: "File uploads and object storage (S3, R2): presigned PUT/POST, server-enforced size and magic-byte type checks, private buckets with short signed GETs, tenant keys, sharp in jobs, malware-scan hook, multipart/resumable, orphan cleanup, CDN headers, local disk. Use when users upload files."
metadata:
  author:
    - ai-pack contributors
---

# File Uploads and Object Storage

Uploads are untrusted input that you store and later serve to other people. Every rule below exists
because one of three things goes wrong: the file is not what it claims (HTML/SVG served as an image,
a decompression bomb), it lands where it should not (another tenant's path, a public bucket, the web
root), or it never gets cleaned up. Code in the references ran in 2026-09 on Node 24.19
(`@aws-sdk/client-s3` 3.1136, `file-type` 22.1, `sharp` 0.35.4; 4 tests, TypeScript 5.9/7.0 clean)
and Python 3.12 (boto3, `filetype` 1.2; 2 tests).

References:
- `references/node.md` - presign + verify + signed download (tested against a fake bucket), local-disk streaming save, sharp variants, multipart/resumable notes
- `references/python.md` - boto3 presigned PUT (tested), streaming size-limited save with magic-byte check (tested), FastAPI notes

## Two SDK traps found while testing (2026-09)

1. **AWS SDK checksum defaults** (`@aws-sdk/client-s3` >= 3.729, boto3 >= 1.36): presigned PUT URLs
   carry `x-amz-checksum-crc32=AAAAAA==` (the checksum of an **empty** body) and uploads to R2 and other
   S3-compatible stores fail. Set `requestChecksumCalculation: 'WHEN_REQUIRED'` and
   `responseChecksumValidation: 'WHEN_REQUIRED'` (boto3: `request_checksum_calculation="when_required"`).
2. **The JS presigner does not sign `Content-Type` by default** (only `content-length;host`), so the
   browser may upload any type. Pass `signableHeaders: new Set(['content-type'])` to `getSignedUrl`.
   boto3 signs both by default. Either way, verify after upload (section 3).

## 1. Architecture

```text
browser --(1) POST /uploads {kind, contentType, size}--> API: authz, allow-list, pending row, presigned PUT (5 min)
browser --(2) PUT bytes--------------------------------> bucket (private)
browser --(3) POST /uploads/:id/complete---------------> API: HEAD size, sniff magic bytes, mark ready | delete
worker  --(4) job: scan, resize, extract metadata-------> variants in bucket, status "available"
viewer  --(5) GET /files/:id---------------------------> API: authz, 302 to a signed GET (1-5 min) or CDN URL
```

- **Direct-to-bucket** (presigned) keeps large bodies off your servers. Proxying through the app is
  fine for small files and needed when you must scan before storing anywhere.
- The **database is the source of truth** for ownership, status and the original filename; the key in
  the bucket is an implementation detail.
- The client chooses an upload **purpose** (`avatar`, `invoice`), never the allowed types, size limit,
  bucket or key.

## 2. Keys, buckets, permissions

- Server-generated keys: `t/<tenantId>/<purpose>/<uuid>` (no user filename, no user-controlled path
  segments). Store the display name in the DB and send it only via `Content-Disposition`.
- **Private buckets by default**; public read only for a deliberately public prefix (marketing
  assets, public avatars) - never "public because signed URLs were annoying".
- The app's credentials are limited to the bucket (and prefix) it needs; separate credentials for
  the processing worker; no account-wide keys in app servers.
- CORS on the bucket: your origins only, methods `PUT` (and `GET` if the browser reads directly),
  headers `content-type`; never `*` with credentials.

## 3. Enforce size and type on the server

| Check | Where |
|---|---|
| Purpose allow-list: types + max bytes | Before presigning |
| Exact `Content-Length` (and `Content-Type`) signed into the URL | Presign (`ContentLength`, `signableHeaders`); AWS S3 presigned POST: `['content-length-range', 1, max]` condition |
| Real size | After upload: `HeadObject` |
| Real type | After upload: first ~4 KB -> magic bytes (`file-type` / Python `filetype`, `puremagic`) - never trust the extension or the declared MIME |
| Content safety | Job: malware scan (ClamAV/clamd or a scanning service) before the file is shared; images re-encoded |

Reject mismatches by deleting the object and marking the upload `rejected`. The presigned PUT stays
valid until it expires, so the client can overwrite a verified object with other bytes of the same
length and type header: after verification copy it to a key the upload URL cannot write (or verify
only after the URL expired), and let processing re-read and re-check that final object. Request-path limits for
proxied uploads: framework body limits (`multer` `limits.fileSize/files/fields` on multer >= 2.4 -
see `security-review` version floors; Next.js Server Actions `bodySizeLimit`; FastAPI read in chunks).

## 4. Serving files safely

- Downloads go through your API: authorize, then redirect to a **signed GET valid for 1-5 minutes**
  (`ResponseContentDisposition`, `ResponseContentType` set by you).
- `Content-Disposition: attachment` for everything except known-safe raster images; `inline` for
  those only. Encode the filename (`filename*=UTF-8''...`), strip CR/LF and quotes.
- **SVG, HTML, XML, PDFs with scripts**: never served inline from your app's origin. Serve user
  content from a separate registrable domain (`usercontent.example.net`), with
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`. Rasterize or sanitize SVGs
  if they must render.
- Public, immutable assets (hash or UUID keys): `Cache-Control: public, max-age=31536000, immutable`
  via a CDN. Private files: `Cache-Control: private, no-store` on the signed response; never let a
  shared cache store an authorized download.

## 5. Processing off the request path

- Image work (resize, format conversion, EXIF strip) runs in a job (`background-jobs`), not in the
  upload request. sharp: `limitInputPixels` (decompression bombs), `failOn: 'warning'` (the default - do not lower it for untrusted input), `.rotate()`
  before stripping metadata, re-encode (drops EXIF GPS and other metadata by default).
- Status machine per upload: `pending -> uploaded -> scanned -> available` (or `rejected`); the UI
  shows "processing" until `available`.
- Keep the original private; serve derived variants.

## 6. Large and resumable uploads

- S3 multipart: `CreateMultipartUpload`, presigned `UploadPart` URLs (5 MiB-5 GiB parts, max 10,000),
  `CompleteMultipartUpload`; `@aws-sdk/lib-storage` `Upload` on the server side.
- Resumable from browsers: tus (`@tus/server` 2 with `@tus/s3-store`, `tus-js-client` 4) or Uppy.
- Bucket lifecycle rule `AbortIncompleteMultipartUpload` after 1-7 days - incomplete parts are billed
  and invisible in normal listings.

## 7. Cleanup and retention

- A scheduled job deletes `pending` uploads older than 24 h (object and row) and orphaned objects
  without a DB row (compare prefix listings against the DB in batches).
- Deleting a user/tenant deletes their objects (GDPR erasure), including variants and backups policy.
- Lifecycle rules for temporary prefixes (`tmp/` expire after 1 day).

## 8. Local disk and self-hosted storage

- Dev and single-VPS apps can store on disk: stream with a byte limit, sniff, write under a data
  directory **outside the web root**, server-generated names, `0600`, backed up with the database.
  Tested implementation: `references/node.md`, `references/python.md`.
- Serve through the app (authz) or `X-Accel-Redirect`/`X-Sendfile` - never a static route over the
  upload directory.
- Self-hosted S3-compatible: MinIO's community edition is archived (repository read-only since
  2026-04, no official binaries/images); evaluate SeaweedFS (Apache-2.0), Garage (AGPL-3.0) or a
  managed store (R2, S3, B2). Put the storage behind one small interface so switching is a config change.

## 9. Review checklist

- [ ] Purpose allow-list decides types and size; client never supplies key, bucket or limits
- [ ] Presigned URLs short-lived (<= 5 min), `Content-Length`/`Content-Type` signed, checksum mode `WHEN_REQUIRED` for S3-compatible stores
- [ ] Post-upload verification: size via HEAD, type via magic bytes; mismatches deleted
- [ ] Private bucket, tenant-prefixed server keys, least-privilege credentials, strict bucket CORS
- [ ] Downloads authorized per request; signed GETs short; `attachment` by default; user content on a separate domain
- [ ] Processing and malware scanning in jobs; decompression-bomb limits; metadata stripped
- [ ] Multipart abort lifecycle rule; pending/orphan cleanup job; deletion on account erasure
- [ ] Local-disk mode: outside web root, streamed limit, not served statically

## Related

- Skills: `background-jobs` (processing, scanning, cleanup), `security-review` (uploads, SSRF, version
  floors), `web-perf` (image formats, caching), `workers-best-practices` / `cloudflare` (R2 bindings),
  `deployment-patterns` (VPS storage and backups)
- Agents: `api-security-auditor`, `web-security-auditor`, `fullstack-feature-builder`, `permission-auditor`
