import type { TokenUsage } from '../../shared/pricing';
import type { Format } from '../types';

/**
 * Lightweight token-usage extraction from streamed or plain responses (Anthropic, OpenAI chat, Responses API).
 * Only chunks that mention "_tokens" are regex-scanned, so most content chunks cost a single indexOf.
 */
export type Usage = TokenUsage;

const TOKEN_FIELDS = new Set([
  'input_tokens', 'prompt_tokens', 'output_tokens', 'completion_tokens', 'cache_read_input_tokens', 'cached_tokens',
  'cache_creation_input_tokens', 'cache_write_tokens', 'cached_creation_tokens',
]);
const INTEGER_LITERAL = /^(0|[1-9]\d*)$/;
const EVENT_BOUNDARY = /\r?\n\r?\n/g;
const MAX_EVENT_CHARS = 256 * 1024;

// Boyer-Moore-Horspool skip table for ASCII `_tokens"` (8 bytes: 95, 116, 111, 107, 101, 110, 115, 34).
const SKIP = new Uint8Array(256).fill(8);
const PAT = [95, 116, 111, 107, 101, 110, 115, 34];
for (let i = 0; i < 7; i++) SKIP[PAT[i]] = 7 - i;

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

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export class UsageTap {
  usage: Usage = { input: null, output: null, cache: null, cacheWrite: null };
  hasFinalUsage = false;
  private decoder = new TextDecoder();
  private pending = '';
  private discard = false;

  constructor(private format: Format) {}

  readBody(text: string): void {
    this.readPayload(text);
  }

  feed(bytes: Uint8Array): void {
    const end = bytes.length - 1;
    const endsEvent = bytes[end] === 10 && (bytes[end - 1] === 10 || (bytes[end - 1] === 13 && bytes[end - 2] === 10));
    if (!this.pending && !this.discard && endsEvent && !hasTokensBytes(bytes)) return;

    const text = this.pending + this.decoder.decode(bytes, { stream: true });
    EVENT_BOUNDARY.lastIndex = Math.max(0, this.pending.length - 3);
    let start = 0;
    let boundary: RegExpExecArray | null;
    while ((boundary = EVENT_BOUNDARY.exec(text)) !== null) {
      if (!this.discard && boundary.index - start <= MAX_EVENT_CHARS) {
        const event = text.slice(start, boundary.index);
        if (event.includes('_tokens"')) {
          const data: string[] = [];
          let type: string | undefined;
          for (const line of event.split(/\r?\n/)) {
            if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
            if (line.startsWith('event:')) type = line.slice(6).trim();
          }
          this.readPayload(data.join('\n'), type ?? '');
        }
      }
      start = EVENT_BOUNDARY.lastIndex;
      this.discard = false;
    }
    if (this.discard || text.length - start > MAX_EVENT_CHARS) {
      // shortcut: skip oversized SSE events for accounting, switch to incremental JSON path extraction if relays need larger usage events
      this.discard = true;
      this.pending = text.slice(-3).match(/[\r\n]+$/)?.[0] ?? '';
    } else {
      this.pending = text.slice(start);
    }
  }

  private readPayload(text: string, eventType?: string): void {
    if (!text.includes('_tokens"')) return;
    let payload: Fields | undefined;
    try {
      const parse = JSON.parse as (input: string, reviver: (key: string, value: unknown, context?: { source: string }) => unknown) => unknown;
      payload = fields(parse(text, (key, value, context) =>
        TOKEN_FIELDS.has(key) && typeof value === 'number' && context && !INTEGER_LITERAL.test(context.source) ? null : value,
      ));
    } catch {
      return;
    }
    if (!payload) return;
    const type = payload.type ?? eventType;
    const stream = eventType !== undefined;
    let candidate: unknown;
    if (this.format === 'anthropic') {
      if (!stream || type === 'message_delta') candidate = payload.usage;
      if (stream && type === 'message_start') candidate = fields(payload.message)?.usage;
    } else if (this.format === 'openai-chat') {
      candidate = payload.usage;
    } else {
      if (!stream || type === 'response.completed' || type === 'response.incomplete') {
        candidate = stream ? fields(payload.response)?.usage : payload.usage ?? fields(payload.response)?.usage;
      }
    }
    const usage = fields(candidate);
    if (!usage) return;

    const chat = this.format === 'openai-chat';
    const details = fields(chat ? usage.prompt_tokens_details : usage.input_tokens_details);
    const input = count(chat ? usage.prompt_tokens : usage.input_tokens);
    const output = count(chat ? usage.completion_tokens : usage.output_tokens);
    const read = count(usage.cache_read_input_tokens) ?? count(details?.cached_tokens) ?? count(usage.cached_tokens);
    const writes = [usage.cache_creation_input_tokens, usage.cache_write_tokens, usage.cached_creation_tokens,
      details?.cache_write_tokens, details?.cached_creation_tokens].map(count);
    const write = Math.max(...writes.map((value) => value ?? -1));
    this.usage.input = input ?? this.usage.input;
    this.usage.output = output ?? this.usage.output;
    this.usage.cache = read ?? this.usage.cache;
    if (write >= 0) this.usage.cacheWrite = write;
    if (!stream || (output !== null && (this.format !== 'anthropic' || type === 'message_delta'))) {
      this.hasFinalUsage = true;
    }
  }
}
