import { useEffect, useState } from 'react';

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * True while the focused element is an input, textarea, select or contenteditable element. Moving
 * focus straight from one field to another keeps it true, so the value does not flicker.
 */
export function useEditableFocus(): boolean {
  const [editing, setEditing] = useState(() => isEditable(document.activeElement));

  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => setEditing(isEditable(event.target));
    const onFocusOut = (event: FocusEvent) => setEditing(isEditable(event.relatedTarget));
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  return editing;
}
