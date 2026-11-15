import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names the item: Delete key "Account 2"? */
  title: string;
  /** Says what else happens. */
  body: string;
  confirmLabel: string;
  pendingLabel: string;
  keepLabel: string;
  /** Rejects with an Error to keep the dialog open and show its message inline. */
  onConfirm: () => Promise<void>;
}

/**
 * Every delete goes through this (D-10). The keep button is the Radix cancel, so focus starts there.
 * Confirm is a plain Button, not the AlertDialog action, which would close the dialog before the
 * request settles: here the dialog stays open and shows the pending label until it does, and a
 * failure shows inline and leaves the item in place.
 */
export function ConfirmDialog({ open, onOpenChange, title, body, confirmLabel, pendingLabel, keepLabel, onConfirm }: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestClose = (next: boolean) => {
    // A close request while the request runs is ignored, so the dialog never hides a pending delete.
    if (pending) return;
    if (!next) setError(null);
    onOpenChange(next);
  };

  const confirm = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      setPending(false);
      onOpenChange(false);
    } catch (err) {
      setPending(false);
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={requestClose}>
      <AlertDialogContent onEscapeKeyDown={(e) => pending && e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm break-words text-destructive">
            {error}
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel className="h-11 md:h-9" disabled={pending}>
            {keepLabel}
          </AlertDialogCancel>
          <Button variant="destructive" className="h-11 md:h-9" onClick={() => void confirm()} disabled={pending}>
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
