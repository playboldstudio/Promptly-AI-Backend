import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'playbold-promptly-prod';

const { parseTags, parseIsPaid, coerceMultipartFields, httpizeMultipartError, parseMultipart } =
  await import('../src/routes/prompts.js');

test('parseTags: comma-joined string becomes a trimmed non-empty array', () => {
  assert.deepEqual(parseTags(' cinematic, portrait ,,'), ['cinematic', 'portrait']);
});

test('parseTags: JSON array fallback is supported', () => {
  assert.deepEqual(parseTags('["cinematic","portrait"]'), ['cinematic', 'portrait']);
});

test('parseTags: empty / missing → empty array', () => {
  assert.deepEqual(parseTags(''), []);
  assert.deepEqual(parseTags(undefined), []);
  assert.deepEqual(parseTags(null), []);
});

test('parseIsPaid: "true" and "1" are truthy, everything else false', () => {
  assert.equal(parseIsPaid('true'), true);
  assert.equal(parseIsPaid('1'), true);
  assert.equal(parseIsPaid(true), true);
  assert.equal(parseIsPaid('false'), false);
  assert.equal(parseIsPaid('0'), false);
  assert.equal(parseIsPaid(''), false);
  assert.equal(parseIsPaid(undefined), false);
});

test('coerceMultipartFields: tags/isPaid/priceInr typed for zod', () => {
  const out = coerceMultipartFields({ tags: 'a,b', isPaid: 'true', priceInr: '499', title: 'T' });
  assert.deepEqual(out.tags, ['a', 'b']);
  assert.equal(out.isPaid, true);
  assert.equal(out.priceInr, 499);
  assert.equal(out.title, 'T');
});

test('coerceMultipartFields: absent priceInr is left absent; garbage stays a string (zod rejects it)', () => {
  assert.equal(Object.hasOwn(coerceMultipartFields({}), 'priceInr'), false);
  assert.equal(coerceMultipartFields({ priceInr: 'abc' }).priceInr, 'abc');
});

test('httpizeMultipartError: LIMIT_FILE_SIZE → clean 413', () => {
  const err = httpizeMultipartError({ code: 'LIMIT_FILE_SIZE' });
  assert.equal(err.status, 413);
  assert.match(err.message, /too large/);
});

test('httpizeMultipartError: LIMIT_UNEXPECTED_FILE / LIMIT_FILE_COUNT → clean 400', () => {
  const err = httpizeMultipartError({ code: 'LIMIT_UNEXPECTED_FILE', field: 'avatar' });
  assert.equal(err.status, 400);
  assert.match(err.message, /avatar/);
  assert.equal(httpizeMultipartError({ code: 'LIMIT_FILE_COUNT' }).status, 400);
});

test('httpizeMultipartError: our own status-bearing error passes through untouched', () => {
  const e = new Error('Only JPG, PNG or WebP images are allowed');
  e.status = 400;
  assert.equal(httpizeMultipartError(e), e);
});

/* ── parseMultipart via a minimal express app + real multipart bodies ────────── */

let server;
let base;
const express = await import('express');

before(async () => {
  const app = express.default();
  app.post('/mp', parseMultipart, (req, res) => {
    res.status(200).json({
      body: req.body,
      cover: (req.files?.image ?? []).map((f) => ({ bytes: f.buffer.length, type: f.mimetype })),
      galleryCount: (req.files?.images ?? []).length,
      bodyType: typeof req.body,
    });
  });
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('multipart: one cover + two gallery files parsed, texts coerced', async () => {
  const form = new FormData();
  form.append('title', 'Neon Portrait');
  form.append('description', 'Cool');
  form.append('promptText', 'A neon portrait prompt');
  form.append('category', 'portrait');
  form.append('tags', 'neon,portrait');
  form.append('isPaid', 'true');
  form.append('priceInr', '49');
  form.append('image', new Blob([PNG], { type: 'image/png' }), 'cover.png');
  form.append('images', new Blob([PNG], { type: 'image/png' }), 'g1.png');
  form.append('images', new Blob([PNG], { type: 'image/webp' }), 'g2.webp');

  const res = await fetch(`${base}/mp`, { method: 'POST', body: form });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.body.title, 'Neon Portrait');
  assert.equal(data.body.isPaid, 'true');
  assert.equal(data.body.priceInr, '49');
  assert.equal(data.body.tags, 'neon,portrait');
  assert.equal(data.bodyType, 'object');
  assert.equal(data.cover.length, 1);
  assert.equal(data.cover[0].bytes, PNG.length);
  assert.equal(data.galleryCount, 2);
});

test('multipart: JSON content-type passes through untouched (multer does not run)', async () => {
  const res = await fetch(`${base}/mp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'X' }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.bodyType, 'undefined'); // no body-parser attached → multer must NOT have parsed it
});

test('multipart: non-image file rejected with a clean 400', async () => {
  const form = new FormData();
  form.append('title', 'No');
  form.append('image', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'notes.txt');
  const res = await fetch(`${base}/mp`, { method: 'POST', body: form });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Only JPG, PNG or WebP/);
});

test('multipart: file over 5 MB → clean 413', async () => {
  const form = new FormData();
  form.append('title', 'Big');
  const big = Buffer.alloc(6 * 1024 * 1024, 1);
  form.append('image', new Blob([big], { type: 'image/jpeg' }), 'big.jpg');
  const res = await fetch(`${base}/mp`, { method: 'POST', body: form });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /too large/);
});