import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { CodeBlock } from '@/components/code-block';
import {
  claudeEnvSnippet,
  claudeSettingsSnippet,
  codexEnvSnippet,
  codexTomlSnippet,
  PLACEHOLDER_KEY,
} from '@/lib/gateway-snippets';
import { cn } from '@/lib/utils';

function Caption({ children }: { children: string }) {
  return <p className="text-xs font-semibold text-muted-foreground">{children}</p>;
}

/** The Claude Code and Codex CLI snippets, filled with the page origin and `apiKey` (the placeholder until a key was just created). */
export function ClientSnippets({ apiKey = PLACEHOLDER_KEY }: { apiKey?: string }) {
  const origin = window.location.origin;
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Claude Code</h3>
        <Caption>Shell exports</Caption>
        <CodeBlock text={claudeEnvSnippet(origin, apiKey)} copyAriaLabel="Copy Claude Code shell exports" />
        <Caption>~/.claude/settings.json</Caption>
        <CodeBlock text={claudeSettingsSnippet(origin, apiKey)} copyAriaLabel="Copy Claude Code settings.json" />
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Codex CLI</h3>
        <Caption>~/.codex/config.toml</Caption>
        <CodeBlock text={codexTomlSnippet(origin)} copyAriaLabel="Copy Codex config.toml" />
        <Caption>Shell export</Caption>
        <CodeBlock text={codexEnvSnippet(apiKey)} copyAriaLabel="Copy Codex GATEWAY_KEY export" />
      </section>
    </div>
  );
}

/** Collapsed by default (D-26): setup snippets with Copy buttons, using the placeholder key. */
export function ClientSetup() {
  const [open, setOpen] = useState(false);
  return (
    <Card className="gap-0 p-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" className="h-auto min-h-11 w-full justify-between rounded-xl px-4 py-3 text-left" aria-expanded={open}>
            <span className="flex min-w-0 flex-col items-start gap-0.5">
              <span className="text-sm font-semibold">Client setup</span>
              <span className="text-xs font-normal whitespace-normal text-muted-foreground">Claude Code and Codex CLI, ready to paste.</span>
            </span>
            <ChevronDown aria-hidden="true" className={cn('transition-transform', open && 'rotate-180')} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-border-subtle p-4">
          <ClientSnippets />
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
