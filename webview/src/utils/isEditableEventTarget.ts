export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const contentEditable = target.getAttribute('contenteditable');

  return target.isContentEditable
    || target.contentEditable === 'true'
    || contentEditable === 'true'
    || contentEditable === ''
    || target.tagName === 'INPUT'
    || target.tagName === 'TEXTAREA'
    || target.tagName === 'SELECT';
}
