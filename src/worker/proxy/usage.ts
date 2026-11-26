import type { TokenUsage } from '../../shared/pricing';

/**
 * Lightweight token-usage extraction from streamed or plain responses (Anthropic, OpenAI chat, Responses API).
 * Only chunks that mention "_tokens" are regex-scanned, so most content chunks cost a single indexOf.
 */
export type Usage = TokenUsage;

const TOKEN_FIELDS: Record<string, keyof Usage> = {
  input_tokens: 'input', prompt_tokens: 'input', output_tokens: 'output', completion_tokens: 'output',
  cache_read_input_tokens: 'cache', cached_tokens: 'cache',
  cache_creation_input_tokens: 'cacheWrite', cache_write_tokens: 'cacheWrite', cached_creation_tokens: 'cacheWrite',
};
const COMPLETE_TOKEN_RE =
  /(?<!\\)"(input_tokens|prompt_tokens|output_tokens|completion_tokens|cache_read_input_tokens|cached_tokens|cache_creation_input_tokens|cache_write_tokens|cached_creation_tokens)"[ \t\r\n]*:[ \t\r\n]*(0|[1-9]\d{0,15})(?=[ \t\r\n]*[,}])/g;

// Boyer-Moore-Horspool skip table for ASCII `_tokens"` (8 bytes: 95, 116, 111, 107, 101, 110, 115, 34).
const SKIP = new Uint8Array(256).fill(8);
const PAT = [95, 116, 111, 107, 101, 110, 115, 34];
for (let i = 0; i < 7; i++) SKIP[PAT[i]] = 7 - i;
const TAIL_BYTES_MAX = 128;

function hasTokensBytes(buf: Uint8Array, len = buf.length): boolean {
  let i = 7;
  while (i < len) {
    const b = buf[i];
    if (b === 34) {
      if (
        buf[i - 7] === 95 &&
        buf[i - 1] === 115 &&
        buf[i - 2] === 110 &&
        buf[i - 3] === 101 &&
        buf[i - 4] === 107 &&
        buf[i - 5] === 111 &&
        buf[i - 6] === 116
      ) {
        return true;
      }
      i += 8;
    } else {
      i += SKIP[b];
    }
  }
  return false;
}

export class UsageTap {
  usage: Usage = { input: null, output: null, cache: null, cacheWrite: null };
  private decoder = new TextDecoder();
  private tail = '';
  private tailBuf = new Uint8Array(TAIL_BYTES_MAX);
  private tailLen = 0;
  private boundaryBuf = new Uint8Array(14);
  private pendingDigits = false;

  /** Seeds the tap with already-decoded initial stream bytes without re-decoding them. */
  seedHead(bytes: Uint8Array, text: string): void {
    if (text) this.feedText(text);
    if (bytes.length > 0) this.pushTailBytes(bytes);
    this.pendingDigits = this.tail.indexOf('_tokens"') !== -1;
  }

  private hasBoundaryTokens(head: Uint8Array): boolean {
    if (this.tailLen === 0 || head.length === 0) return false;
    if (SKIP[this.tailBuf[this.tailLen - 1]] === 8) return false;
    const tKeep = this.tailLen > 7 ? 7 : this.tailLen;
    const hKeep = head.length > 7 ? 7 : head.length;
    const tStart = this.tailLen - tKeep;
    for (let i = 0; i < tKeep; i++) this.boundaryBuf[i] = this.tailBuf[tStart + i];
    for (let i = 0; i < hKeep; i++) this.boundaryBuf[tKeep + i] = head[i];
    return hasTokensBytes(this.boundaryBuf, tKeep + hKeep);
  }

  private pushTailBytes(cur: Uint8Array): void {
    const n = cur.length;
    if (n >= TAIL_BYTES_MAX) {
      const start = n - TAIL_BYTES_MAX;
      for (let i = 0; i < TAIL_BYTES_MAX; i++) this.tailBuf[i] = cur[start + i];
      this.tailLen = TAIL_BYTES_MAX;
      return;
    }
    const keep = Math.min(this.tailLen, TAIL_BYTES_MAX - n);
    if (keep > 0) this.tailBuf.copyWithin(0, this.tailLen - keep, this.tailLen);
    this.tailBuf.set(cur, keep);
    this.tailLen = keep + n;
  }

  feed(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const hit = this.pendingDigits || hasTokensBytes(bytes) || this.hasBoundaryTokens(bytes);
    if (!hit) {
      this.pushTailBytes(bytes);
      this.tail = '';
      return;
    }
    if (!this.tail && this.tailLen > 0) {
      this.tail = this.decoder.decode(this.tailBuf.subarray(0, this.tailLen));
    }
    this.feedText(this.decoder.decode(bytes, { stream: true }));
    this.pushTailBytes(bytes);
    this.pendingDigits = this.tail.indexOf('_tokens"') !== -1;
  }

  feedText(chunk: string): void {
    const text = this.tail ? this.tail + chunk : chunk;
    const idx = text.indexOf('_tokens"');
    let lastCompleteEnd = 0;
    if (idx !== -1) {
      COMPLETE_TOKEN_RE.lastIndex = Math.max(0, idx - 32);
      let match: RegExpExecArray | null;
      while ((match = COMPLETE_TOKEN_RE.exec(text)) !== null) {
        lastCompleteEnd = COMPLETE_TOKEN_RE.lastIndex;
        const count = Number(match[2]);
        const field = TOKEN_FIELDS[match[1]];
        const current = this.usage[field];
        if (Number.isSafeInteger(count) && (current === null || count > current)) this.usage[field] = count;
      }
    }
    this.tail = text.slice(Math.max(lastCompleteEnd, text.length - TAIL_BYTES_MAX));
  }
}
