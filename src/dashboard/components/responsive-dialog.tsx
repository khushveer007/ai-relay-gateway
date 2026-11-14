import type { ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { useIsDesktop } from '@/hooks/use-media-query';

type ResponsiveDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  footer?: ReactNode;
  children: ReactNode;
};

// Centered Dialog at 768px and above, bottom Drawer (vaul) below. Header, body and footer chrome always
// render; an empty body is the caller's own empty state. The body is a plain scrolling div, not a
// ScrollArea with only a max height: a ScrollArea viewport needs a definite height to scroll (Pitfall 7).
// The title element is always rendered because Radix and vaul warn when it is missing.
export function ResponsiveDialog({ open, onOpenChange, title, description, footer, children }: ResponsiveDialogProps) {
  const isDesktop = useIsDesktop();

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          // sm:max-w-[680px] is needed because the shadcn base carries sm:max-w-sm, which a bare max-w would not override.
          className="flex max-h-[88vh] max-w-[680px] flex-col gap-0 p-0 sm:max-w-[680px]"
          // No description: say so explicitly, otherwise Radix warns about a missing aria-describedby.
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <DialogHeader className="shrink-0 gap-1 px-6 pt-6 pr-14 pb-4">
            <DialogTitle className="truncate" title={title}>
              {title}
            </DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-4">{children}</div>
          {footer ? <DialogFooter className="mx-0 mb-0 shrink-0 px-6 py-4">{footer}</DialogFooter> : null}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
      <DrawerContent
        className="flex max-h-[90dvh] flex-col"
        {...(description ? {} : { 'aria-describedby': undefined })}
      >
        <DrawerHeader className="shrink-0 text-left">
          <DrawerTitle className="truncate" title={title}>
            {title}
          </DrawerTitle>
          {description ? <DrawerDescription>{description}</DrawerDescription> : null}
        </DrawerHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-2">{children}</div>
        {footer ? <DrawerFooter className="shrink-0 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</DrawerFooter> : null}
      </DrawerContent>
    </Drawer>
  );
}
