import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ActionBadge, HttpStatusBadge } from '@/components/status-badge';
import { ResponsiveDialog } from '@/components/responsive-dialog';
import type { LogRowDTO } from '@/lib/api';
import { fmtMs, fmtNum, fmtRequestCost, fmtTime, fmtTokensOrDash, MATCH_LABEL, plainActionText } from '@/lib/format';
import { logModelLine } from '@/lib/logs-filters';
import type { LogLabels } from './log-columns';

interface LogDetailDialogProps {
  log: LogRowDTO;
  labels: LogLabels;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm wrap-anywhere">{children}</dd>
    </div>
  );
}

function Section({ title, children, titleClassName = 'text-xs tracking-wide text-muted-foreground uppercase' }: {
  title: string; children: ReactNode; titleClassName?: string;
}) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h3 className={'font-semibold ' + titleClassName}>{title}</h3>
      {children}
    </section>
  );
}

const DASH = '—';

/**
 * The full story of one request (D-20): request, result, timing, tokens, then every upstream attempt in
 * the order it was tried. Every string is a React child that wraps (break-words), so request text from a
 * relay can never inject markup or push the layout sideways (T-02-26).
 */
export function LogDetailDialog({ log, labels, open, onOpenChange }: LogDetailDialogProps) {
  const attempts = log.attempts ?? [];
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Request ${fmtTime(log.ts)}`}
      footer={
        <Button variant="outline" className="h-11 flex-1 md:h-9 md:flex-none" onClick={() => onOpenChange(false)}>
          Close request details
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        <Section title="Request">
          <dl className="flex flex-col gap-2">
            <Row label="Path">{log.path}</Row>
            <Row label="Model">{log.model ? logModelLine(log) : DASH}</Row>
            <Row label="Format">{log.format}</Row>
            <Row label="Stream">{log.stream ? 'yes' : 'no'}</Row>
            <Row label="Gateway key">{labels.gatewayKey(log.gateway_key_id)}</Row>
            <Row label="Route">{labels.route(log.route_id)}</Row>
            <Row label="Provider / key">{`${labels.provider(log.provider_id)} / ${labels.key(log.key_id)}`}</Row>
          </dl>
        </Section>

        <Section title="Result">
          <dl className="flex flex-col gap-2">
            <Row label="Status">
              <HttpStatusBadge status={log.status} />
            </Row>
            {log.error ? <Row label="Error">{plainActionText(log.error)}</Row> : null}
            {log.failovers > 0 ? <Row label="Failovers">{log.failovers}</Row> : null}
          </dl>
        </Section>

        <Section title="Timing">
          <dl className="flex flex-col gap-2">
            <Row label="TTFB">{fmtMs(log.ttfb_ms)}</Row>
            <Row label="Total">{fmtMs(log.latency_ms)}</Row>
          </dl>
        </Section>

        <Section title="Tokens">
          <dl className="flex flex-col gap-2">
            <Row label="Input">{fmtTokensOrDash(log.input_tokens)}</Row>
            <Row label="Output">{fmtTokensOrDash(log.output_tokens)}</Row>
            <Row label="Cache read">{fmtTokensOrDash(log.cache_tokens)}</Row>
            <Row label="Cache write">{fmtTokensOrDash(log.cache_write_tokens)}</Row>
          </dl>
        </Section>

        <Section title="List-price cost" titleClassName="text-sm">
          <dl className="flex flex-col gap-2">
            <Row label="Cost">
              <span className={log.cost_nano_usd != null ? 'font-mono tabular-nums' : undefined}>
                {fmtRequestCost(log.cost_nano_usd, log.cost_reason)}
              </span>
            </Row>
            {log.priced_model && <Row label="Priced model"><span className="font-mono">{log.priced_model}</span></Row>}
            {log.price_match_type && <Row label="Match type">{MATCH_LABEL[log.price_match_type]}</Row>}
            {log.price_tier_threshold_tokens != null && (
              <Row label="Long-context threshold">{fmtNum(log.price_tier_threshold_tokens)} tokens</Row>
            )}
          </dl>
          {log.price_match_type == null && log.cost_nano_usd == null && log.cost_reason == null && (
            <p className="text-sm text-muted-foreground">Pricing details weren’t recorded for this request.</p>
          )}
        </Section>

        <Section title="Attempts">
          {attempts.length === 0 ? (
            <p className="text-sm break-words text-muted-foreground">
              No upstream attempts recorded. {log.error ? plainActionText(log.error) : 'Rejected before reaching an upstream.'}
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {attempts.map((a, i) => (
                <li key={i} className="flex flex-col gap-1.5 rounded-lg border border-border-subtle p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">#{i + 1}</span>
                    <HttpStatusBadge status={a.status} />
                    <ActionBadge action={a.action} />
                    <span className="font-mono text-xs text-muted-foreground">{a.ms} ms</span>
                  </div>
                  <p className="text-sm wrap-anywhere">
                    {a.provider} · {a.key} · model {a.model || DASH}
                  </p>
                  {a.reason ? <p className="text-xs break-words text-muted-foreground">{plainActionText(a.reason)}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>
    </ResponsiveDialog>
  );
}
