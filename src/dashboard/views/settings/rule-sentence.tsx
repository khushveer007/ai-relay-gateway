import { RiskNote } from '@/components/risk-note';
import type { ErrorRuleDTO, ProviderDTO } from '@/lib/api';
import { ruleSentence } from '@/lib/rule-form';

export function RuleSentence({ rule, providers }: { rule: ErrorRuleDTO; providers: ProviderDTO[] }) {
  const { sentence, message, note } = ruleSentence(rule, providers);
  return (
    <div className="flex min-w-0 flex-col gap-2 [&>div:empty]:hidden md:[&>div]:order-last">
      <p className="text-sm font-semibold wrap-anywhere">{sentence}</p>
      {rule.action === 'INVALID_KEY' ? <RiskNote text={rule.status_codes} /> : null}
      {message ? <p className="font-mono text-xs break-all text-muted-foreground">{message}</p> : null}
      {note ? <p className="text-xs wrap-anywhere text-muted-foreground">{note}</p> : null}
    </div>
  );
}
