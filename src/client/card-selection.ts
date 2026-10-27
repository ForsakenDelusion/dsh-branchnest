import type { KeyboardEvent, PointerEvent } from 'react'

const editable = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'

/** Pointer reading establishes the same keyboard scope as tab navigation. */
export function focusCardBody(event: PointerEvent<HTMLElement>): void {
  const target = event.target
  if (event.button !== 0 || !(target instanceof Element) || target.closest(`${editable},button,a,summary`)) return
  event.currentTarget.focus({ preventScroll: true })
}

/** Select this card's mounted readable body while leaving native editor shortcuts alone. */
export function selectCardBody(event: KeyboardEvent<HTMLElement>, body: HTMLElement | null): void {
  if (!body || event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.shiftKey
    || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'a') return
  if (event.target instanceof Element && event.target.closest(editable)) return
  const selection = body.ownerDocument.getSelection()
  if (!selection) return
  event.preventDefault(); event.stopPropagation()
  body.focus({ preventScroll: true })
  const range = body.ownerDocument.createRange()
  range.selectNodeContents(body); selection.removeAllRanges(); selection.addRange(range)
}
