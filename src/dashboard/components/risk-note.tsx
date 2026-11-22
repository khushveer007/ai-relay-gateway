import { Info, TriangleAlert } from 'lucide-react';
import { codeRisk, riskNoteText } from '@/lib/status-codes';
import { cn } from '@/lib/utils';

export function RiskNote({ text, id }: { text: string; id?: string }) {
  const risk = codeRisk(text);
  const note = riskNoteText(risk);
  const amber = risk.level === 'amber';
  const Icon = amber ? TriangleAlert : Info;

  return (
    <div id={id} aria-live="polite">
      {note && (
        <div className={cn('flex items-start gap-2', amber && 'rounded-md border border-status-warn/40 bg-status-warn/10 p-2')}>
          <Icon className={cn('size-4 shrink-0', amber ? 'text-status-warn' : 'text-muted-foreground')} aria-hidden="true" />
          <p className={cn('min-w-0 text-xs wrap-anywhere', amber ? 'text-foreground' : 'text-muted-foreground')}>{note}</p>
        </div>
      )}
    </div>
  );
}
