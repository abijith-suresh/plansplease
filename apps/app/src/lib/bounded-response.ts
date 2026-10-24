export async function readBoundedResponseBytes(
  response: Response,
  options: {
    maxBytes: number;
    unavailableMessage: string;
    tooLargeMessage: string;
    checkContentLength?: boolean;
  }
): Promise<Uint8Array> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(options.unavailableMessage);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (
      options.checkContentLength &&
      Number(response.headers.get("content-length")) > options.maxBytes
    ) {
      throw new Error(options.tooLargeMessage);
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > options.maxBytes) throw new Error(options.tooLargeMessage);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
