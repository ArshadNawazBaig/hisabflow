/** Enforce byte limits while streaming, even when Content-Length is missing. */
export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('The request body exceeds its size limit.');
    this.name = 'RequestBodyTooLargeError';
  }
}

export async function readBoundedBody(request: Request, maximumBytes: number): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new RangeError('Invalid request size limit.');
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximumBytes) {
    await request.body?.cancel().catch(() => {});
    throw new RequestBodyTooLargeError();
  }
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

export async function readBoundedFormData(request: Request, maximumBytes: number): Promise<FormData> {
  const bytes = await readBoundedBody(request, maximumBytes);
  return new Response(bytes, { headers: { 'Content-Type': request.headers.get('content-type') || '' } }).formData();
}
