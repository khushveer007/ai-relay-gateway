import { useRef, type RefObject } from 'react';
import { CopyButton } from '@/components/copy-button';
import { cn } from '@/lib/utils';

interface CodeBlockProps {
  text: string;
  /** Wrap long text (the key) instead of scrolling sideways, and select all of it on a tap. */
  wrap?: boolean;
  copyLabel?: string;
  copyAriaLabel?: string;
  /** Set to render no Copy button here (the owner shows its own, e.g. in a dialog footer). */
  hideCopy?: boolean;
  /** The owner can read the code element to select it when the clipboard is unavailable. */
  codeRef?: RefObject<HTMLElement | null>;
}

/**
 * Mono 12px text on the muted background with a Copy button at the top right. By default it scrolls
 * sideways inside its own box so the page never does; `wrap` is for the key. `data-vaul-no-drag` so
 * selecting or scrolling in it never reads as a swipe inside a drawer.
 */
export function CodeBlock({ text, wrap = false, copyLabel = 'Copy', copyAriaLabel, hideCopy = false, codeRef }: CodeBlockProps) {
  const ownRef = useRef<HTMLElement | null>(null);
  const ref = codeRef ?? ownRef;
  return (
    <div data-vaul-no-drag className="flex max-w-full min-w-0 flex-col gap-2 rounded-lg bg-muted p-3">
      {hideCopy ? null : (
        <div className="flex justify-end">
          <CopyButton text={text} label={copyLabel} ariaLabel={copyAriaLabel} getSelectTarget={() => ref.current} />
        </div>
      )}
      <pre className={cn('max-w-full font-mono text-xs', wrap ? 'break-all whitespace-pre-wrap select-all' : 'overflow-x-auto whitespace-pre')}>
        <code ref={ref}>{text}</code>
      </pre>
    </div>
  );
}
