/** Keep keyboard focus in an open dialog and restore its opener when it closes. */
export function activateModalFocus(dialog: HTMLElement, initialFocus: HTMLElement, onClose: () => void): () => void {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusInitial = () => initialFocus.focus({ preventScroll: true });
  focusInitial();
  const onFocus = (event: FocusEvent) => {
    if (!dialog.contains(event.target as Node)) focusInitial();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const entries = [...dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")]
      .filter(element => !element.hidden && !element.closest("[hidden], [inert]"));
    event.preventDefault();
    if (!entries.length) { focusInitial(); return; }
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (at <= 0 ? entries.length - 1 : at - 1) : (at + 1) % entries.length;
    entries[next]!.focus({ preventScroll: true });
  };
  document.addEventListener("keydown", onKey);
  document.addEventListener("focusin", onFocus);
  return () => {
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("focusin", onFocus);
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
}
