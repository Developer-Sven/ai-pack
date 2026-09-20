# Uploads in Node: presign, verify, serve, process

Ran 2026-09 on Node 24.19 with `@aws-sdk/client-s3` / `s3-request-presigner` 3.1136, `file-type`
22.1.1, `sharp` 0.35.4: 4/4 tests (presign contents, post-upload verification against a fake bucket,
local-disk limits, image variants and bomb rejection); `tsc --strict` clean on TypeScript 5.9 and 7.0.

## storage.ts (S3 / R2 / S3-compatible)

```ts
// storage.ts - direct-to-bucket uploads (S3, R2, other S3-compatible stores) with server-side enforcement.
// Flow: POST /uploads (presign) -> browser PUTs the bytes to the bucket -> POST /uploads/:id/complete (verify)
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { fileTypeFromBuffer } from 'file-type';

export const s3 = new S3Client({
  region: process.env.S3_REGION ?? 'auto', // R2: 'auto'
  endpoint: process.env.S3_ENDPOINT, // R2: https://<account>.r2.cloudflarestorage.com ; AWS: leave undefined
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
  // SDK >= 3.729 adds CRC32 checksums by default; presigned PUTs then carry the checksum of an EMPTY body
  // and S3-compatible stores reject uploads. Only send checksums when an API requires them:
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const BUCKET = process.env.S3_BUCKET ?? 'uploads';

/** What each upload purpose may contain. The client picks a purpose, never a MIME list or a size. */
export const KINDS = {
  avatar: { maxBytes: 5 * 1024 * 1024, types: ['image/png', 'image/jpeg', 'image/webp'] },
  document: { maxBytes: 25 * 1024 * 1024, types: ['application/pdf'] },
} as const;
export type Kind = keyof typeof KINDS;

export interface PendingUpload {
  id: string;
  key: string;
  kind: Kind;
  ownerId: string;
  tenantId: string;
  contentType: string;
  size: number;
  status: 'pending' | 'ready' | 'rejected';
  createdAt: Date;
}

export class UploadRejected extends Error {}

/** Step 1: validate the declaration, create a pending record, sign a short-lived PUT for exactly that type and size. */
export async function presignUpload(
  req: { tenantId: string; ownerId: string; kind: Kind; contentType: string; size: number },
  client: S3Client = s3,
): Promise<{ upload: PendingUpload; url: string; headers: Record<string, string> }> {
  const rule = KINDS[req.kind];
  if (!rule) throw new UploadRejected('unknown upload kind');
  if (!(rule.types as readonly string[]).includes(req.contentType)) throw new UploadRejected('file type not allowed');
  if (!Number.isInteger(req.size) || req.size < 1 || req.size > rule.maxBytes) throw new UploadRejected('file too large');
  const id = randomUUID();
  // Server-generated key, tenant-prefixed; the user's filename never becomes a path (store it separately if needed).
  const key = `t/${req.tenantId}/${req.kind}/${id}`;
  const url = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: req.contentType, ContentLength: req.size }),
    // content-length is signed by default; content-type is NOT unless listed here (verified with SDK 3.1136).
    { expiresIn: 300, signableHeaders: new Set(['content-type']) },
  );
  const upload: PendingUpload = { id, key, kind: req.kind, ownerId: req.ownerId, tenantId: req.tenantId,
    contentType: req.contentType, size: req.size, status: 'pending', createdAt: new Date() };
  return { upload, url, headers: { 'content-type': req.contentType } };
}

/** Step 2 (after the browser's PUT): trust nothing the client said - check size and magic bytes in the bucket. */
export async function verifyUpload(u: PendingUpload, client: S3Client = s3): Promise<'ready' | 'rejected'> {
  const rule = KINDS[u.kind];
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: u.key }));
    if (!head.ContentLength || head.ContentLength > rule.maxBytes || head.ContentLength !== u.size) throw new UploadRejected('size mismatch');
    const first = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: u.key, Range: 'bytes=0-4099' }));
    const bytes = await first.Body!.transformToByteArray();
    const sniffed = await fileTypeFromBuffer(bytes); // magic bytes, not the extension or the declared type
    if (!sniffed || sniffed.mime !== u.contentType) throw new UploadRejected(`content is ${sniffed?.mime ?? 'unknown'}`);
    return 'ready'; // then: enqueue processing (resize, scan) - never on the request path
  } catch (err) {
    if (!(err instanceof UploadRejected)) throw err; // S3 outage etc.: keep it pending and retry later
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: u.key }));
    return 'rejected';
  }
}

/** Private bucket, short-lived download link, forced download for anything that is not a safe image. */
export async function downloadUrl(u: PendingUpload, filename: string, client: S3Client = s3): Promise<string> {
  const inline = u.contentType.startsWith('image/') && u.contentType !== 'image/svg+xml';
  const safeName = encodeURIComponent(filename.replace(/[\r\n"]/g, '').slice(0, 150));
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: u.key,
      ResponseContentType: u.contentType,
      ResponseContentDisposition: `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${safeName}`,
    }),
    { expiresIn: 300 },
  );
}
```

Route wiring (Express 5 style; adapt to Next route handlers / Hono):

```ts
const PresignBody = z.strictObject({
  kind: z.enum(['avatar', 'document']),
  contentType: z.string().max(100),
  size: z.number().int().positive(),
});
app.post('/uploads', requireSession, async (req, res) => {
  const body = PresignBody.parse(req.body);
  const { upload, url, headers } = await presignUpload({ ...body, tenantId: req.session.tenantId, ownerId: req.session.userId });
  await uploadsRepo.insert(upload); // status 'pending'
  res.status(201).json({ id: upload.id, url, method: 'PUT', headers });
});
app.post('/uploads/:id/complete', requireSession, async (req, res) => {
  const upload = await uploadsRepo.getPending(req.session.tenantId, req.session.userId, req.params.id); // owner-scoped
  if (!upload) return res.status(404).end();
  const status = await verifyUpload(upload);
  await uploadsRepo.setStatus(upload.id, status);
  if (status === 'ready') await jobs.send('process-upload', { uploadId: upload.id });
  res.status(status === 'ready' ? 202 : 422).json({ status });
});
```

Browser side: `await fetch(url, { method: 'PUT', headers, body: file })` - the `content-type` header
must equal the signed one and the body length must equal `size`, or the bucket answers 403.

Check-then-use gap: the presigned URL can be replayed until it expires (5 min), so bytes verified by
`/complete` can be swapped afterwards for different bytes of the same length. Before marking the upload
`ready`, `CopyObjectCommand` it to a final key (e.g. `f/<tenantId>/<kind>/<id>`) that no presigned URL
targets, delete the upload key, and serve/process only the final key - or complete only after
`createdAt + 300 s`.

## Tests (fake bucket; presigning is offline math)

```ts
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { makeVariants } from './images.ts';
import { BadType, saveUpload, TooLarge } from './local-disk.ts';
import { downloadUrl, presignUpload, UploadRejected, verifyUpload } from './storage.ts';

const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#3a7' } })
  .withMetadata({ exif: { IFD0: { Copyright: 'secret-gps-owner' } } }).png().toBuffer();
const creds = { region: 'auto', endpoint: 'https://acc.r2.cloudflarestorage.com', credentials: { accessKeyId: 'AKID', secretAccessKey: 's' } };

/** A fake bucket: presigning is local math; HEAD/GET/DELETE hit this map instead of the network. */
function fakeClient(objects: Map<string, Buffer>): S3Client {
  const c = new S3Client({ ...creds, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  c.send = (async (cmd: unknown) => {
    const input = (cmd as { input: { Key: string } }).input;
    const obj = objects.get(input.Key);
    if (cmd instanceof DeleteObjectCommand) return void objects.delete(input.Key);
    if (!obj) throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
    if (cmd instanceof HeadObjectCommand) return { ContentLength: obj.length };
    if (cmd instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => new Uint8Array(obj.subarray(0, 4100)) } };
    throw new Error('unexpected command');
  }) as S3Client['send'];
  return c;
}

test('presign: allow-listed kind/type/size, server key, signed content-type and length, no empty-body checksum', async () => {
  const objects = new Map<string, Buffer>();
  const { upload, url } = await presignUpload({ tenantId: 't1', ownerId: 'u1', kind: 'avatar', contentType: 'image/png', size: png.length }, fakeClient(objects));
  const u = new URL(url);
  assert.match(upload.key, /^t\/t1\/avatar\/[0-9a-f-]{36}$/);
  assert.equal(u.searchParams.get('X-Amz-SignedHeaders'), 'content-length;content-type;host');
  assert.equal(u.searchParams.get('X-Amz-Expires'), '300');
  assert.equal(u.searchParams.has('x-amz-checksum-crc32'), false);
  await assert.rejects(presignUpload({ tenantId: 't1', ownerId: 'u1', kind: 'avatar', contentType: 'image/svg+xml', size: 10 }), UploadRejected);
  await assert.rejects(presignUpload({ tenantId: 't1', ownerId: 'u1', kind: 'avatar', contentType: 'image/png', size: 6e6 }), UploadRejected);
});

test('verify: magic bytes and size are checked in the bucket; mismatches are deleted', async () => {
  const objects = new Map<string, Buffer>();
  const client = fakeClient(objects);
  const ok = (await presignUpload({ tenantId: 't1', ownerId: 'u1', kind: 'avatar', contentType: 'image/png', size: png.length }, client)).upload;
  objects.set(ok.key, png);
  assert.equal(await verifyUpload(ok, client), 'ready');

  const html = Buffer.from('<html><script>alert(1)</script></html>'.padEnd(200, ' '));
  const fake = (await presignUpload({ tenantId: 't1', ownerId: 'u1', kind: 'avatar', contentType: 'image/png', size: html.length }, client)).upload;
  objects.set(fake.key, html); // declared image/png, actually HTML
  assert.equal(await verifyUpload(fake, client), 'rejected');
  assert.equal(objects.has(fake.key), false, 'rejected object deleted');

  const url = new URL(await downloadUrl(ok, 'my "avatar".png\r\nX: y', client));
  assert.match(url.searchParams.get('response-content-disposition')!, /^inline; filename\*=UTF-8''my%20avatar.pngX%3A%20y$/);
});

test('local disk: stream limit, sniffed type and extension, no partial files left', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'up-'));
  const saved = await saveUpload(Readable.from([png.subarray(0, 10), png.subarray(10)]), { root, tenantId: 't1', maxBytes: 1e6, types: ['image/png'] });
  assert.match(saved.key, /^t1\/[0-9a-f-]{36}\.png$/);
  await assert.rejects(saveUpload(Readable.from([Buffer.alloc(600_000), Buffer.alloc(600_000)]), { root, tenantId: 't1', maxBytes: 1e6, types: ['image/png'] }), TooLarge);
  await assert.rejects(saveUpload(Readable.from([Buffer.from('%PDF-1.7 not an image')]), { root, tenantId: 't1', maxBytes: 1e6, types: ['image/png'] }), BadType);
  await assert.rejects(saveUpload(Readable.from([png]), { root, tenantId: '../etc', maxBytes: 1e6, types: ['image/png'] }), /invalid tenant/);
  assert.deepEqual((await readdir(path.join(root, 't1'))).filter((f) => f.endsWith('.part')), []);
});

test('images: variants are webp, metadata stripped, bombs rejected', async () => {
  const v = await makeVariants(png);
  assert.equal((await sharp(v.thumb).metadata()).format, 'webp');
  assert.equal((await sharp(v.thumb).metadata()).exif, undefined, 'EXIF removed');
  assert.deepEqual([v.width, v.height], [64, 48]);
  const bomb = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: '#000' } }).png({ compressionLevel: 9 }).toBuffer();
  await assert.rejects(makeVariants(bomb), /pixel limit/i);
});
```

## local-disk.ts (dev / single VPS)

```ts
// local-disk.ts - dev/VPS fallback: stream a request body to disk with a hard byte limit and a magic-byte check.
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileTypeFromBuffer } from 'file-type';

export class TooLarge extends Error {}
export class BadType extends Error {}

export async function saveUpload(
  body: Readable,
  opts: { root: string; tenantId: string; maxBytes: number; types: readonly string[] },
): Promise<{ key: string; mime: string; size: number }> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(opts.tenantId)) throw new Error('invalid tenant id'); // no path traversal
  const dir = path.join(opts.root, opts.tenantId);
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const tmp = path.join(dir, `.${id}.part`);
  let size = 0;
  let head = Buffer.alloc(0);
  const guard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > opts.maxBytes) return cb(new TooLarge(`limit ${opts.maxBytes} bytes`)); // stop reading immediately
      if (head.length < 4100) head = Buffer.concat([head, chunk]).subarray(0, 4100);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(body, guard, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    const sniffed = await fileTypeFromBuffer(head);
    if (!sniffed || !opts.types.includes(sniffed.mime)) throw new BadType(`content is ${sniffed?.mime ?? 'unknown'}`);
    const key = `${opts.tenantId}/${id}.${sniffed.ext}`; // extension from the sniffed type, not from the client
    await rename(tmp, path.join(opts.root, key));
    return { key, mime: sniffed.mime, size };
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
```

Pipe the raw request body (`Content-Type: application/octet-stream` + declared name in a header or
field) or a single multipart part (busboy / multer's stream) into `saveUpload`. The limit aborts the
stream as soon as it is exceeded - the rest of the body is never written.

## images.ts (run in a job)

```ts
// images.ts - run in a job, not in the request: decode untrusted images with limits, strip metadata, re-encode.
import sharp from 'sharp';

sharp.concurrency(1); // per job; scale with worker processes instead
sharp.cache(false);

export async function makeVariants(input: Buffer): Promise<{ thumb: Buffer; large: Buffer; width: number; height: number }> {
  const img = sharp(input, {
    limitInputPixels: 40_000_000, // ~40 MP: rejects decompression bombs (default is 268 MP)
    failOn: 'warning', // the default and sharp's advice for untrusted input: corrupt/truncated data throws
    animated: false,
  }).rotate(); // apply EXIF orientation before the metadata is dropped
  const meta = await img.metadata();
  const [thumb, large] = await Promise.all([
    img.clone().resize(256, 256, { fit: 'cover' }).webp({ quality: 80 }).toBuffer(), // metadata (EXIF GPS!) not copied
    img.clone().resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer(),
  ]);
  return { thumb, large, width: meta.width ?? 0, height: meta.height ?? 0 };
}
```

## AWS S3 presigned POST (browser form uploads with a size range)

R2 does not support presigned POST; on AWS S3 it lets the bucket enforce a size **range**:

```ts
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

const { url, fields } = await createPresignedPost(s3, {
  Bucket: 'uploads',
  Key: key,
  Conditions: [
    ['content-length-range', 1, 5 * 1024 * 1024],
    ['eq', '$Content-Type', 'image/png'],
  ],
  Fields: { 'Content-Type': 'image/png' }, // every condition needs its field value set here
  Expires: 300,
});
// browser: FormData with all `fields` first, then the file as the last field "file"
```

## Multipart for large files (server-side helper)

```ts
import { Upload } from '@aws-sdk/lib-storage';
await new Upload({ client: s3, params: { Bucket: 'exports', Key: key, Body: readableStream, ContentType: 'text/csv' },
  queueSize: 4, partSize: 8 * 1024 * 1024 }).done();
```

Browser-resumable uploads: tus (`@tus/server` 2.4 + `@tus/s3-store` 2.0, client `tus-js-client` 4.3)
- authorize in the server's `onUploadCreate` hook, set the object key yourself, cap `maxSize`.
