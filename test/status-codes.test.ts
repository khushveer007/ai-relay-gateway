import { describe, expect, it } from 'vitest';
import {
  DROP_CODE_ERRORS,
  DROP_MESSAGE_NEEDS_CODES,
  codeRisk,
  formatRiskTokens,
  parseStatusCodes,
  riskNoteText,
} from '../src/dashboard/lib/status-codes';

// One line per value so a failing assertion prints on a single line (keeps a TDD RED report valid TAP).
const j = (v: unknown): string => JSON.stringify(v).replace(/"/g, "'");
const parse = (text: string): string => j(parseStatusCodes(text));
const risk = (text: string): string => j(codeRisk(text));

describe('parseStatusCodes (DROP-06 ordering)', () => {
  it('DROP-06 ordering: comma, space and padded forms give the same codes, and the typed order is kept', () => {
    expect(parse('403, 418')).toBe(j({ codes: '403,418', error: null }));
    expect(parse('403 418')).toBe(j({ codes: '403,418', error: null }));
    expect(parse('403,418')).toBe(j({ codes: '403,418', error: null }));
    expect(parse(' 403 ,418 ')).toBe(j({ codes: '403,418', error: null }));
    expect(parse('418 403')).toBe(j({ codes: '418,403', error: null }));
  });

  it('DROP-06 adjacency: touching ranges and repeated codes are stored as typed', () => {
    expect(parse('500-503')).toBe(j({ codes: '500-503', error: null }));
    expect(parse('500-503 503-505')).toBe(j({ codes: '500-503,503-505', error: null }));
    expect(parse('403 403')).toBe(j({ codes: '403,403', error: null }));
  });

  it('DROP-06 empty: blank text gives no codes and no error', () => {
    expect(parse('')).toBe(j({ codes: '', error: null }));
    expect(parse('   ')).toBe(j({ codes: '', error: null }));
  });

  it('rejects junk, a run-on pair, a trailing comma, and a short code or range as unreadable', () => {
    for (const bad of ['abc', '403418', '402,', '40', '500-59']) {
      expect(parseStatusCodes(bad).error).toBe('unreadable');
    }
  });

  it('DROP-06 adjacency: a reversed range is rejected as reversed', () => {
    expect(parseStatusCodes('503-500').error).toBe('reversed');
  });

  it('rejects a code outside 400 to 599 as out of range with the default range', () => {
    for (const bad of ['200', '399', '600', '400-700']) {
      expect(parseStatusCodes(bad).error).toBe('out_of_range');
    }
  });

  it('accepts a code from 100 to 999 when the caller passes that range', () => {
    expect(j(parseStatusCodes('200', { min: 100, max: 999 }))).toBe(j({ codes: '200', error: null }));
  });
});

describe('drop-list wording (UI-SPEC)', () => {
  it('uses the agreed text for each code error and for a message with no codes', () => {
    expect(j(DROP_CODE_ERRORS)).toBe(
      j({
        unreadable: 'Enter codes like 403, 418 or 500-503.',
        out_of_range: 'Use error codes from 400 to 599.',
        reversed: 'A range must go up, like 500-503.',
      }),
    );
    expect(DROP_MESSAGE_NEEDS_CODES).toBe('Add a status code to use this message.');
  });
});

describe('codeRisk (DROP-09)', () => {
  it('DROP-09 empty: blank text has no level and no tokens', () => {
    expect(risk('')).toBe(j({ level: null, tokens: [] }));
    expect(risk('  ')).toBe(j({ level: null, tokens: [] }));
  });

  it('DROP-09 boundaries: 400, 404, 408, 413, 422, 429, 500 and 599 are amber', () => {
    for (const code of ['400', '404', '408', '413', '422', '429', '500', '599']) {
      expect(risk(code)).toBe(j({ level: 'amber', tokens: [code] }));
    }
  });

  it('DROP-09 boundaries: 403 is grey', () => {
    expect(risk('403')).toBe(j({ level: 'grey', tokens: ['403'] }));
  });

  it('DROP-09 boundaries: 399, 401, 402, 499, 600 and 200-299 carry no risk', () => {
    for (const code of ['399', '401', '402', '499', '600', '200-299']) {
      expect(risk(code)).toBe(j({ level: null, tokens: [] }));
    }
  });

  it('DROP-09 adjacency: a range is amber when it includes a risky code', () => {
    expect(risk('400-499')).toBe(j({ level: 'amber', tokens: ['400-499'] }));
    expect(risk('500-503')).toBe(j({ level: 'amber', tokens: ['500-503'] }));
  });

  it('DROP-09 adjacency: 402-403 is grey, because 403 is its only risky code', () => {
    expect(risk('402-403')).toBe(j({ level: 'grey', tokens: ['402-403'] }));
  });

  it('DROP-09 ordering: when amber and grey are both typed, the level is amber and only amber tokens are listed', () => {
    expect(risk('403, 429')).toBe(j({ level: 'amber', tokens: ['429'] }));
  });

  it('DROP-09 ordering: tokens keep the typed order', () => {
    expect(risk('429, 400, 500')).toBe(j({ level: 'amber', tokens: ['429', '400', '500'] }));
  });

  it('DROP-09 empty: unreadable tokens are ignored and never raise an error', () => {
    expect(risk('abc, 429')).toBe(j({ level: 'amber', tokens: ['429'] }));
    expect(risk('abc')).toBe(j({ level: null, tokens: [] }));
  });

  it('a reversed range gives no risk', () => {
    expect(risk('503-500')).toBe(j({ level: null, tokens: [] }));
  });
});

describe('formatRiskTokens and riskNoteText (DROP-09 ordering, D-09)', () => {
  it('joins up to four tokens with commas', () => {
    expect(formatRiskTokens(['400', '404'])).toBe('400, 404');
    expect(formatRiskTokens(['400', '404', '408', '413'])).toBe('400, 404, 408, 413');
  });

  it('caps the list at four tokens and then says how many more', () => {
    expect(formatRiskTokens(['400', '404', '408', '413', '422'])).toBe('400, 404, 408, 413 and 1 more');
  });

  it('the amber note starts with Risky and carries the capped token list', () => {
    expect(riskNoteText({ level: 'amber', tokens: ['400', '404', '408', '413', '422'] })).toBe(
      'Risky: 400, 404, 408, 413 and 1 more. Often temporary, so dropping a key on this can switch off every key during an outage.',
    );
    expect(riskNoteText({ level: 'amber', tokens: ['429'] })).toMatch(/^Risky: 429\./);
  });

  it('the grey note is the 403 sentence, and no risk has no note', () => {
    expect(riskNoteText({ level: 'grey', tokens: ['403'] })).toBe(
      '403 can be a short block rather than a bad key. Dropping on it keeps the key off until you re-enable it.',
    );
    expect(riskNoteText({ level: null, tokens: [] })).toBeNull();
  });
});
