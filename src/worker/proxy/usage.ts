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

function maxOf(re: RegExp, text: string, current: number | null): number | null {
  re.lastIndex = 0;
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

  feed(bytes: Uint8Array): void {
    this.feedText(this.decoder.decode(bytes, { stream: true }));
  }

  feedText(chunk: string): void {
    const text = this.tail + chunk;
    if (text.indexOf('_tokens"') !== -1) this.scan(text);
    // Keep a small tail so values split across chunk boundaries are still found (max() makes rescans harmless).
    this.tail = text.length > 256 ? text.slice(-256) : text;
  }

  private scan(text: string): void {
    this.usage.input = maxOf(INPUT_RE, text, this.usage.input);
    this.usage.output = maxOf(OUTPUT_RE, text, this.usage.output);
    this.usage.cache = maxOf(CACHE_RE, text, this.usage.cache);
  }
}
