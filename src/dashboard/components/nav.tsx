import { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, KeyRound, LayoutDashboard, Route, ScrollText, Settings, Zap, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { NAV_LABEL, VIEW_IDS, type ViewId } from '@/lib/routes';

export const NAV_ICON: Record<ViewId, LucideIcon> = {
  overview: LayoutDashboard,
  providers: Zap,
  routes: Route,
  'gateway-keys': KeyRound,
  logs: ScrollText,
  settings: Settings,
};

export function ProxyUrlBox() {
  const [copied, setCopied] = useState(false);
  const urlRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The Proxy Base URL is the public origin only: no keys or secrets are ever shown here (T-01-13).
  const origin = window.location.origin;

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(origin);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Select the text as well, so the operator only has to use the phone's own Copy action.
      const el = urlRef.current;
      const selection = window.getSelection();
      if (el && selection) {
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      toast.error('Copy failed. Select the URL and copy it by hand.');
    }
  };

  return (
    <div className="rounded-lg border border-border-subtle bg-background/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-muted-foreground">Proxy Base URL</span>
        <Button variant="ghost" size="sm" aria-label="Copy proxy base URL" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <div ref={urlRef} className="mt-1 break-all font-mono text-xs text-cyan select-all">
        {origin}
      </div>
    </div>
  );
}

interface SidebarContentProps {
  view: ViewId;
  onSignOut: () => void;
  signingOut: boolean;
  /** Called when a destination is chosen, so the phone menu can close even when the hash does not change. */
  onNavigate?: () => void;
}

/** Brand, the six destinations, the Proxy Base URL box and Sign Out. It has no data of its own, so it never loads or errors. */
export function SidebarContent({ view, onSignOut, signingOut, onNavigate }: SidebarContentProps) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-primary to-ring text-primary-foreground">
          <ArrowLeftRight className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">AI Relay Gateway</div>
          <div className="truncate text-xs text-muted-foreground">Cloudflare Workers</div>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <nav aria-label="Dashboard navigation">
          <ul className="flex flex-col gap-1">
            {VIEW_IDS.map((id) => {
              const Icon = NAV_ICON[id];
              const active = id === view;
              return (
                <li key={id}>
                  <a
                    href={'#/' + id}
                    title={NAV_LABEL[id]}
                    aria-current={active ? 'page' : undefined}
                    onClick={onNavigate}
                    className={cn(
                      'flex min-h-11 items-center gap-2 rounded-lg border px-2.5 text-sm font-semibold outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 md:min-h-9',
                      active
                        ? 'border-primary/50 bg-accent text-foreground'
                        : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">{NAV_LABEL[id]}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
      </ScrollArea>

      <div className="flex flex-col gap-3">
        <Separator />
        <ProxyUrlBox />
        <Button variant="ghost" className="justify-start" onClick={onSignOut} disabled={signingOut}>
          {signingOut ? 'Signing out…' : 'Sign Out'}
        </Button>
      </div>
    </div>
  );
}
