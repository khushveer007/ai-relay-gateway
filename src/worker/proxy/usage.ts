/**
 * Lightweight token-usage extraction from streamed or plain responses (Anthropic, OpenAI chat, Responses API).
 * Only chunks that mention "_tokens" are regex-scanned, so most content chunks cost a single indexOf.
 */
export interface Usage {
  input: number | null;
  output: number | null;
  cache: number | null;
}

const INPUT_RE = /"(?:input_tokens|prompt_tokens)"\s*:\s*(\d+)/g;
const OUTPUT_RE = /"(?:output_tokens|completion_tokens)"\s*:\s*(\d+)/g;
const CACHE_RE = /"(?:cache_read_input_tokens|cached_tokens)"\s*:\s*(\d+)/g;
const COMPLETE_TOKEN_RE =
  /"(?:input_tokens|prompt_tokens|output_tokens|completion_tokens|cache_read_input_tokens|cached_tokens)"\s*:\s*\d+(?=[^\d])/g;

// Boyer-Moore-Horspool skip table for ASCII `_tokens"` (8 bytes: 95, 116, 111, 107, 101, 110, 115, 34).
const SKIP = new Uint8Array(256).fill(8);
const PAT = [95, 116, 111, 107, 101, 110, 115, 34];
for (let i = 0; i < 7; i++) SKIP[PAT[i]] = 7 - i;
const TAIL_BYTES_MAX = 48;

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

function maxOf(re: RegExp, text: string, current: number | null, startIndex = 0): number | null {
  re.lastIndex = startIndex;
  let best = current;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (best === null || n > best) best = n;
  }
  return best;
}

export class UsageTap {
  usage: Usage = { input: null, output: null, cache: null };
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
    if (idx !== -1) {
      const start = Math.max(0, idx - 32);
      this.scan(text, start);
      COMPLETE_TOKEN_RE.lastIndex = start;
      let lastCompleteEnd = 0;
      let m: RegExpExecArray | null;
      while ((m = COMPLETE_TOKEN_RE.exec(text)) !== null) {
        lastCompleteEnd = m.index + m[0].length;
      }
      const rem = lastCompleteEnd > 0 ? text.slice(lastCompleteEnd) : text;
      this.tail = rem.length > 48 ? rem.slice(-48) : rem;
    } else {
      this.tail = text.length > 48 ? text.slice(-48) : text;
    }
  }

  private scan(text: string, startIndex = 0): void {
    this.usage.input = maxOf(INPUT_RE, text, this.usage.input, startIndex);
    this.usage.output = maxOf(OUTPUT_RE, text, this.usage.output, startIndex);
    this.usage.cache = maxOf(CACHE_RE, text, this.usage.cache, startIndex);
  }
}
