import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, csvToObjects } from '../src/utils/csv.js';
import { validateBulkRows, isImageFilename, normalizeImageName } from '../src/utils/prompt-import.js';

const SAMPLE_CSV = [
  'title,description,promptText,category,tags,isPaid,priceInr,image',
  'Cinematic Portrait,Cinematic portrait prompt,A cinematic...,portrait,"cinematic,portrait",false,,001.jpg',
  'Luxury Fashion,Luxury fashion prompt,Editorial fashion...,fashion,"luxury,editorial",true,49,002.jpg',
  'Travel Shot,Travel photography prompt,Beautiful travel...,travel,"travel,photo",false,,003.jpg',
].join('\n');

test('parseCsv: handles quotes, commas and header mapping', () => {
  const { header, rows } = csvToObjects(SAMPLE_CSV);
  assert.deepEqual(header, ['title', 'description', 'prompttext', 'category', 'tags', 'ispaid', 'priceinr', 'image']);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].tags, 'cinematic,portrait');
  assert.equal(rows[1].ispaid, 'true');
  assert.equal(rows[2].image, '003.jpg');
});

test('parseCsv: skips blank lines and handles quoted newlines', () => {
  const text = 'a,b\n1,2\n\n3,"x\ny"\n';
  const records = parseCsv(text);
  assert.equal(records.length, 3);
  assert.deepEqual(records[2], ['3', 'x\ny']);
});

test('parseCsv: strips a leading UTF-8 BOM', () => {
  const records = parseCsv('\uFEFFa,b\n1,2');
  assert.deepEqual(records[0], ['a', 'b']);
});

test('validateBulkRows: valid rows import-ready, fields normalized', () => {
  const images = new Map([
    ['001.jpg', { buffer: Buffer.alloc(1), mimetype: 'image/jpeg' }],
    ['002.jpg', { buffer: Buffer.alloc(1), mimetype: 'image/jpeg' }],
    ['003.jpg', { buffer: Buffer.alloc(1), mimetype: 'image/jpeg' }],
  ]);
  const result = validateBulkRows(SAMPLE_CSV, images);
  assert.equal(result.error, null);
  assert.equal(result.valid.length, 3);
  assert.equal(result.errors.length, 0);
  assert.equal(result.valid[0].category, 'portrait');
  assert.equal(result.valid[1].isPaid, true);
  assert.equal(result.valid[1].priceInr, 49);
  assert.deepEqual(result.valid[0].tags, ['cinematic', 'portrait']);
});

test('validateBulkRows: missing image, bad category, paid-without-price flagged', () => {
  const images = new Map([['pic.jpg', { buffer: Buffer.alloc(1), mimetype: 'image/jpeg' }]]);
  const csv = [
    'title,description,promptText,category,tags,isPaid,priceInr,image',
    'Missing File,desc,text,portrait,,false,,missing.jpg',
    'No Image,desc,text,portrait,,false,,',
    'Bad Cat,desc,text,unknown,,false,,pic.jpg',
    'Paid No Price,desc,text,portrait,,true,,pic.jpg',
  ].join('\n');
  const result = validateBulkRows(csv, images);
  assert.equal(result.valid.length, 0);
  assert.equal(result.errors.length, 4);
  assert.match(result.errors[0].reason, /not found/);
  assert.match(result.errors[1].reason, /image is required/);
  assert.match(result.errors[2].reason, /valid category/);
  assert.match(result.errors[3].reason, /positive price \(INR\)/);
});

test('validateBulkRows: duplicate titles and promptText flagged', () => {
  const images = new Map([
    ['a.jpg', { buffer: Buffer.alloc(1), mimetype: 'image/jpeg' }],
    ['b.jpg', { buffer: Buffer.alloc(1), mimetype: 'image/jpeg' }],
  ]);
  const csv = [
    'title,description,promptText,category,image',
    'Same,desc A,text A,portrait,a.jpg',
    'Same,desc B,text A,portrait,b.jpg',
  ].join('\n');
  const result = validateBulkRows(csv, images);
  assert.equal(result.valid.length, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].reason, /Duplicate/);
});

test('validateBulkRows: missing required columns reported', () => {
  const result = validateBulkRows('title,description\n1,2', new Map());
  assert.match(result.error, /missing required columns/);
  assert.equal(result.valid.length, 0);
});

test('isImageFilename / normalizeImageName: windows paths and case', () => {
  assert.equal(isImageFilename('001.jpg'), true);
  assert.equal(isImageFilename('photos/001.PNG'), true);
  assert.equal(isImageFilename('photo.txt'), false);
  assert.equal(normalizeImageName('folder\\Sub\\001.JPG'), '001.jpg');
});