import { useEffect, useRef } from 'react';

/**
 * The error banner at the top of a dialog body. The body scrolls while the Save button sits in a fixed
 * footer, so on a phone the banner can be above the viewport when it appears and the failure would look
 * like nothing happened. It scrolls itself into view each time it mounts or its message changes.
 */
export function FormError({ message }: { message: string | null | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [message]);
  if (!message) return null;
  return (
    <div ref={ref} role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm break-words text-destructive">
      {message}
    </div>
  );
}
