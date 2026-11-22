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
 * Save in the provider's batch, preserving the rule ID until the operator clears the list.
 * Create passes the provider name so the insert can find the new provider ID in the same batch.
 */
export function dropListStmts(db: D1Database, providerRef: number | string, dl: DropList): D1PreparedStatement[] {
  if (!dl.touched) return [];
  const isName = typeof providerRef === 'string';
  if (dl.codes === '') {
    return isName ? [] : [db.prepare("DELETE FROM error_rules WHERE provider_id = ? AND origin = 'drop_list'").bind(providerRef)];
  }
  const pattern = dl.message === null ? null : escapeLiteral(dl.message);
  const providerSql = isName ? '(SELECT id FROM providers WHERE name = ?1)' : '?1';
  const insert = db
    .prepare(
      `INSERT INTO error_rules (provider_id, priority, status_codes, body_regex, action, cooldown_s, note, enabled, origin)
       SELECT ${providerSql}, ?2, ?3, ?4, 'INVALID_KEY', NULL, ?5, 1, 'drop_list'
       ${isName ? '' : "WHERE NOT EXISTS (SELECT 1 FROM error_rules WHERE provider_id = ?1 AND origin = 'drop_list')"}`,
    )
    .bind(providerRef, DROP_LIST_PRIORITY, dl.codes, pattern, dl.message);
  if (isName) return [insert];
  return [
    db
      .prepare("UPDATE error_rules SET status_codes = ?, body_regex = ?, note = ? WHERE provider_id = ? AND origin = 'drop_list'")
      .bind(dl.codes, pattern, dl.message, providerRef),
    insert,
  ];
}
