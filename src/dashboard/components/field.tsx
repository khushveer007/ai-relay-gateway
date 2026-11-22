import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface FieldProps {
  label: string;
  htmlFor: string;
  /** Muted helper text; hidden while an error shows. */
  helper?: ReactNode;
  error?: string;
  className?: string;
  children: ReactNode;
}

/** The id the control should reference through aria-describedby for this field's helper or error. */
export const fieldMessageId = (htmlFor: string) => `${htmlFor}-message`;

// Label (12/600), control, then helper (12/400 muted) or error (12/400 destructive, wraps).
export function Field({ label, htmlFor, helper, error, className, children }: FieldProps) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <Label htmlFor={htmlFor} className="leading-[1.4]">{label}</Label>
      {children}
      {error ? (
        <p id={fieldMessageId(htmlFor)} className="text-xs break-words text-destructive">
          {error}
        </p>
      ) : helper ? (
        <p id={fieldMessageId(htmlFor)} className="text-xs break-words text-muted-foreground">
          {helper}
        </p>
      ) : null}
    </div>
  );
}
