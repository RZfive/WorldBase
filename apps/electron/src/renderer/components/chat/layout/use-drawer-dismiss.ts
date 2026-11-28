import { onBeforeUnmount, type Ref } from 'vue'

function landsIn (root: HTMLElement | null | undefined, target: EventTarget | null): boolean {
  if (!root || !target || typeof Node === 'undefined') return false
  return target instanceof Node && root.contains(target)
}

/**
 * Lets a drawer that has no backdrop go away the way people expect one to:
 * on Escape, or on a press that both starts and ends outside of it.
 *
 * The chat around the drawer stays interactive, so such a click closes the
 * drawer *and* lands on whatever was clicked. Listeners are attached once for
 * the lifetime of the caller and consult `isOpen` on every event, which keeps
 * them inert while the drawer is out.
 *
 * The click listener is deliberately in the bubble phase: a trigger that
 * toggles the drawer (three-dot button) runs first and closes it, so by the
 * time this sees the click the drawer is already gone and nothing re-opens.
 */
export function useDrawerDismiss (
  root: Ref<HTMLElement | null | undefined>,
  isOpen: () => boolean,
  dismiss: () => void
): void {
  let pressedOutside = false

  function onPointerDown (event: PointerEvent): void {
    pressedOutside = isOpen() && !landsIn(root.value, event.target)
  }

  // Requiring the release outside too keeps a selection that begins in the
  // drawer and ends beside it from closing it: that click is reported on an
  // ancestor the two points share.
  function onClick (event: MouseEvent): void {
    const outside = pressedOutside && !landsIn(root.value, event.target)
    pressedOutside = false
    if (outside) dismiss()
  }

  function onKeydown (event: KeyboardEvent): void {
    if (event.key === 'Escape' && isOpen()) dismiss()
  }

  document.addEventListener('pointerdown', onPointerDown)
  document.addEventListener('click', onClick)
  document.addEventListener('keydown', onKeydown)
  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onPointerDown)
    document.removeEventListener('click', onClick)
    document.removeEventListener('keydown', onKeydown)
  })
}
