import { DROP_CODE_ERRORS, DROP_MESSAGE_NEEDS_CODES, parseStatusCodes } from '../../dashboard/lib/status-codes';

// The Worker shares the dashboard's pure parser (lib/status-codes), so the server and the form can never disagree
// about which codes are valid.

/** Below the 0 minimum the rule form allows, so a drop-list row beats an operator rule for the same provider (D-06). */
export const DROP_LIST_PRIORITY = -1;

const MAX_CODES_CHARS = 100;
const MAX_MESSAGE_CHARS = 200;

/**
 * Escapes every regex metacharacter, so the stored body_regex matches the operator's text literally (D-05). The
 * classifier compiles body_regex case-insensitively, so the match is literal and case-insensitive.
 */
export function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface DropList {
  /** True when the request carried either field. An untouched list keeps its stored row. */
  touched: boolean;
  /** Normalized codes text, or '' for no drop list. */
  codes: string;
  /** The message as typed, or null when there is none. */
  message: string | null;
  /** A user-facing error, or null when the list is valid. The caller turns it into a 400 before any write. */
  error: string | null;
}

/**
 * Validates the drop_codes and drop_message fields from a request body. Returns the error instead of throwing,
 * because HttpError lives in routes.ts and importing it here would be circular.
 */
export function parseDropList(codes: unknown, message: unknown): DropList {
  const touched = codes !== undefined || message !== undefined;
  if (!touched) return { touched: false, codes: '', message: null, error: null };

  const codesText = codes === undefined || codes === null ? '' : codes;
  const messageText = message === undefined || message === null ? '' : message;
  if (typeof codesText !== 'string' || typeof messageText !== 'string') {
    return { touched, codes: '', message: null, error: 'drop_codes and drop_message must be text' };
  }
  if (codesText.length > MAX_CODES_CHARS) return { touched, codes: '', message: null, error: 'drop_codes is too long' };
  if (messageText.length > MAX_MESSAGE_CHARS) return { touched, codes: '', message: null, error: 'drop_message is too long' };

  const parsed = parseStatusCodes(codesText);
  if (parsed.error) return { touched, codes: '', message: null, error: DROP_CODE_ERRORS[parsed.error] };

  const trimmedMessage = messageText.trim();
  if (parsed.codes === '') {
    // A message with no codes has nothing to drop on. A blank message with no codes means no drop list at all.
    if (trimmedMessage !== '') return { touched, codes: '', message: null, error: DROP_MESSAGE_NEEDS_CODES };
    return { touched, codes: '', message: null, error: null };
  }
  return { touched, codes: parsed.codes, message: trimmedMessage === '' ? null : trimmedMessage, error: null };
}

/**
 * The statements that save a provider's drop list. An untouched list returns nothing. A touched list deletes the
 * provider's drop-list row, then inserts one row when codes are present. Create passes the provider name, and the
 * insert finds the new provider id with a bound subquery inside the same batch.
 */
export function dropListStmts(db: D1Database, providerRef: number | string, dl: DropList): D1PreparedStatement[] {
  if (!dl.touched) return [];
  const isName = typeof providerRef === 'string';
  const stmts: D1PreparedStatement[] = [];
  const providerSql = isName ? '(SELECT id FROM providers WHERE name = ?)' : '?';
  if (!isName) {
    stmts.push(db.prepare("DELETE FROM error_rules WHERE provider_id = ? AND origin = 'drop_list'").bind(providerRef));
  }
  if (dl.codes !== '') {
    stmts.push(
      db
        .prepare(
          `INSERT INTO error_rules (provider_id, priority, status_codes, body_regex, action, cooldown_s, note, enabled, origin)
           VALUES (${providerSql}, ?, ?, ?, 'INVALID_KEY', NULL, ?, 1, 'drop_list')`,
        )
        .bind(providerRef, DROP_LIST_PRIORITY, dl.codes, dl.message === null ? null : escapeLiteral(dl.message), dl.message),
    );
  }
  return stmts;
}
