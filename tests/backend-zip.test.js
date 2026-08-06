'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const zip = require('../lib/zip');
const unzip = require('../lib/unzip');

test('ZIP скачанной папки имеет стандартный EOCD и читается обратно', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controlgui-zip-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(source, 'hello.txt'), 'Привет');
  fs.writeFileSync(path.join(source, 'nested', 'data.json'), '{"ok":true}');

  const chunks = [];
  const stream = new PassThrough();
  stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const ended = new Promise((resolve, reject) => {
    stream.once('end', resolve);
    stream.once('error', reject);
  });
  await zip.zipDirToStream(source, stream);
  await ended;

  const archive = Buffer.concat(chunks);
  const entries = unzip.readEntries(archive, 20);
  const hello = entries.find((entry) => entry.name === 'hello.txt');
  const nested = entries.find((entry) => entry.name === 'nested/data.json');
  assert.ok(hello);
  assert.ok(nested);
  assert.equal(unzip.entryData(archive, hello, 1024).toString('utf8'), 'Привет');
  assert.equal(unzip.entryData(archive, nested, 1024).toString('utf8'), '{"ok":true}');
});
