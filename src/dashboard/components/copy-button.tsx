import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface CopyButtonProps {
  text: string;
  /** Button text; becomes "Copied" for 1.5 s after a successful copy. Default "Copy". */
  label?: string;
  ariaLabel?: string;
  /** The element to select when the clipboard is unavailable, so the operator is never left with nothing selected. */
  getSelectTarget?: () => HTMLElement | null;
  className?: string;
}

function selectNode(el: HTMLElement | null): void {
  const selection = window.getSelection();
  if (!el || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Copies `text` with the Clipboard API. When it is missing (a non-secure origin) or rejects, the source
 * text is selected and a toast asks for a manual copy (UI-SPEC Copy behavior).
 */
export function CopyButton({ text, label = 'Copy', ariaLabel, getSelectTarget, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      selectNode(getSelectTarget?.() ?? null);
      toast.error('Copy failed. Select the text and copy it by hand.');
    }
  };

  return (
    <Button type="button" variant="outline" size="sm" className={cn('h-11 md:h-8', className)} aria-label={ariaLabel} onClick={() => void copy()}>
      {copied ? 'Copied' : label}
    </Button>
  );
}
