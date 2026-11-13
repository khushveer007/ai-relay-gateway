/**
 * Peeks at the beginning of an SSE stream to decide whether it is real content or an error that some relays send
 * with HTTP 200 (e.g. `event: error` / `data: {"error": …}`). Nothing has been sent to the client yet, so on error
 * the gateway can still fail over. On content, the buffered bytes are re-emitted unchanged, followed by the rest of
 * the stream.
 */
export interface PeekResult {
  kind: 'content' | 'error';
  head: Uint8Array;
  headText: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  done: boolean;
}

const MAX_PEEK_BYTES = 8192;

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Returns the first SSE event that carries a data line, or null if none is complete yet. */
export function firstDataEvent(text: string): string | null {
  const normalized = text.replace(/\r\n/g, '\n');
  let start = 0;
  while (true) {
    const end = normalized.indexOf('\n\n', start);
    if (end === -1) return null;
    const ev = normalized.slice(start, end);
    if (/^data:/m.test(ev)) return ev;
    start = end + 2; // comment / ping / empty event → keep looking
  }
}

export function isErrorEvent(ev: string): boolean {
  if (/^event:\s*error\s*$/m.test(ev)) return true;
  const data = ev
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('\n');
  return /^\{\s*"(error"\s*:|type"\s*:\s*"error")/.test(data);
}

export async function peekStream(body: ReadableStream<Uint8Array>): Promise<PeekResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let text = '';
  let done = false;

  while (true) {
    const r = await reader.read();
    if (r.done) {
      done = true;
      break;
    }
    chunks.push(r.value);
    total += r.value.length;
    text += decoder.decode(r.value, { stream: true });
    const ev = firstDataEvent(text);
    if (ev !== null) {
      const head = concat(chunks, total);
      return { kind: isErrorEvent(ev) ? 'error' : 'content', head, headText: text, reader, done: false };
    }
    if (total >= MAX_PEEK_BYTES) break;
  }

  const head = concat(chunks, total);
  // Stream ended (or grew huge) without a complete data event. Some relays send a bare JSON error here.
  const trimmed = text.trim();
  const ev = firstDataEvent(text + '\n\n');
  const isError =
    trimmed === '' ||
    (ev !== null && isErrorEvent(ev)) ||
    (/^\{/.test(trimmed) && /"error"/.test(trimmed.slice(0, 400)));
  return { kind: isError && total < MAX_PEEK_BYTES ? 'error' : 'content', head, headText: text, reader, done };
}
