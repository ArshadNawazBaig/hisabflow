import test from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedBody, readBoundedFormData, RequestBodyTooLargeError } from '../lib/server/request-body.ts';

const request = (body, headers = {}) => new Request('https://hisabflow.example/api/workspace', { method: 'POST', body, headers, duplex: 'half' });

test('body size limits count UTF-8 bytes rather than JavaScript characters', async () => {
  const text = 'کاروبار';
  const bytes = new TextEncoder().encode(text);
  assert.ok(bytes.length > text.length);
  assert.equal(new TextDecoder().decode(await readBoundedBody(request(text), bytes.length)), text);
  await assert.rejects(readBoundedBody(request(text), text.length), RequestBodyTooLargeError);
});

test('streamed requests without Content-Length stop reading and cancel at the limit', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6]));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readBoundedBody(request(stream), 5), RequestBodyTooLargeError);
  assert.equal(cancelled, true);
});

test('a false small Content-Length cannot bypass the actual body limit', async () => {
  await assert.rejects(readBoundedBody(request('too large', { 'Content-Length': '1' }), 4), RequestBodyTooLargeError);
});

test('an oversized declared Content-Length rejects before reading the body', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(readBoundedBody(request(stream, { 'Content-Length': '100' }), 5), RequestBodyTooLargeError);
  assert.equal(cancelled, true);
});

test('empty bodies and exact limits remain valid, while invalid limits fail immediately', async () => {
  assert.equal((await readBoundedBody(request(null), 0)).byteLength, 0);
  assert.equal(new TextDecoder().decode(await readBoundedBody(request('hello'), 5)), 'hello');
  for (const limit of [-1, NaN, 1.5]) await assert.rejects(readBoundedBody(request(''), limit), RangeError);
});

test('bounded form parsing preserves normal OAuth form submissions and PDF uploads', async () => {
  const oauth = request(new URLSearchParams({ intent: 'signin' }));
  assert.equal((await readBoundedFormData(oauth, 2048)).get('intent'), 'signin');
  const form = new FormData();
  form.set('file', new File(['%PDF-1.7\nfixture'], 'statement.pdf', { type: 'application/pdf' }));
  const parsed = await readBoundedFormData(request(form), 4096);
  assert.equal(parsed.get('file').name, 'statement.pdf');
  assert.equal(await parsed.get('file').text(), '%PDF-1.7\nfixture');
});
