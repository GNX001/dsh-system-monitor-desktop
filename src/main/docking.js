/**
 * Dock geometry and the auto-hide state machine.
 *
 * Deliberately pure: no Electron import, no timers, no DOM. `main/index.js`
 * feeds it a cursor position and a clock and applies whatever it decides, which
 * is what makes the tricky part — "is the pointer reaching for a bar that is
 * almost entirely off-screen?" — testable without opening a window.
 *
 * The docked bar keeps its **own size** — the same capsule it is while floating —
 * and sits centred against the top edge of the work area. Hidden, it slides up so
 * only {@link PEEK_PX} pixels remain visible; the pointer is not over that sliver,
 * it is over whatever is behind it, so reveal has to be driven by the global
 * cursor position rather than by DOM hover events.
 */

/** How many pixels of the bar stay visible while it is hidden at the top edge. */
export const PEEK_PX = 6

/** Extra pixels outside the bar that still count as reaching for it. */
export const GRAB_SLACK_PX = 2

/** How long the pointer must stay away before the bar hides itself again. */
export const COLLAPSE_DELAY_MS = 600

/** Gap between the floating bar and the work-area edges, in pixels. */
const FLOAT_MARGIN = 12

/**
 * Left edge of the docked bar: horizontally centred in the work area.
 *
 * Centred rather than pinned to one corner because the bar is only as wide as its
 * text, and it is the sliver's position that tells the user where to reach.
 *
 * @param workArea - the display's work area.
 * @param width - the bar's own width in CSS pixels.
 */
export function dockedX(workArea, width) {
  const barWidth = Math.max(1, Math.round(width))
  return Math.round(workArea.x + Math.max(0, (workArea.width - barWidth) / 2))
}

/**
 * Bounds for the docked bar.
 * @param workArea - the display's work area (taskbar already excluded).
 * @param bar - the bar's own size in CSS pixels (`{width, height}`).
 * @param expanded - true to show the bar, false to leave only the sliver.
 */
export function dockedBounds(workArea, bar, expanded) {
  const width = Math.max(1, Math.round(bar.width))
  const height = Math.max(1, Math.round(bar.height))
  return {
    x: dockedX(workArea, width),
    y: expanded ? Math.round(workArea.y) : Math.round(workArea.y - (height - PEEK_PX)),
    width,
    height,
  }
}

/**
 * Whether the pointer is on the part of the docked bar that is actually visible.
 *
 * Hidden, that is the sliver (plus a little slack) — the pointer can never reach
 * the rest, because the OS will not deliver a position above the work area.
 * Visible, it is the whole bar, which is what keeps it open while in use. Only the
 * bar's own width counts horizontally: it no longer spans the screen, so reaching
 * for the top-left corner is not reaching for the bar.
 *
 * @param cursor - absolute screen point (`screen.getCursorScreenPoint()`).
 * @param workArea - the display's work area.
 * @param bar - the bar's own size (`{width, height}`).
 * @param expanded - whether the bar is currently shown.
 */
export function isCursorOverBar(cursor, workArea, bar, expanded) {
  if (cursor === null || cursor === undefined) return false
  const width = Math.max(1, Math.round(bar.width))
  const left = dockedX(workArea, width)
  if (cursor.x < left - GRAB_SLACK_PX || cursor.x >= left + width + GRAB_SLACK_PX) return false
  const bottom = expanded
    ? workArea.y + Math.max(1, Math.round(bar.height))
    : workArea.y + PEEK_PX + GRAB_SLACK_PX
  return cursor.y >= workArea.y - GRAB_SLACK_PX && cursor.y < bottom
}

/** The dock state a freshly pinned bar starts in: shown, so it is not a surprise. */
export function initialDockState(now) {
  return { expanded: true, lastOverAt: now }
}

/**
 * Advance the dock state by one observation.
 *
 * Reveal is immediate (a delay before showing feels broken); hiding waits
 * {@link COLLAPSE_DELAY_MS} of absence so brushing past the top edge does not
 * make the bar flap.
 *
 * @param state - `{ expanded, lastOverAt }`.
 * @param input - `{ cursor, workArea, bar, now, pinned, collapseDelayMs }`.
 * @returns the next state (the same object when nothing changed).
 */
export function reduceDockState(state, input) {
  const collapseDelayMs = input.collapseDelayMs ?? COLLAPSE_DELAY_MS
  const now = input.now

  // Unpinned bars float and never auto-hide.
  if (input.pinned !== true) {
    return state.expanded === true ? state : { expanded: true, lastOverAt: now }
  }

  if (isCursorOverBar(input.cursor, input.workArea, input.bar, state.expanded)) {
    return { expanded: true, lastOverAt: now }
  }

  if (state.expanded === true && now - state.lastOverAt >= collapseDelayMs) {
    return { expanded: false, lastOverAt: state.lastOverAt }
  }

  return state
}

/**
 * Keep a floating bar fully inside the work area.
 * @param position - desired `{x, y}` in screen coordinates.
 * @param size - the bar's `{width, height}`.
 * @param workArea - the display's work area.
 */
export function clampFloatingPosition(position, size, workArea) {
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - size.width)
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - size.height)
  return {
    x: Math.round(Math.min(maxX, Math.max(workArea.x, position.x))),
    y: Math.round(Math.min(maxY, Math.max(workArea.y, position.y))),
  }
}

/** Where an unpinned bar starts: top-right, just inside the work area. */
export function defaultFloatingPosition(size, workArea) {
  return clampFloatingPosition(
    { x: workArea.x + workArea.width - size.width - FLOAT_MARGIN * 2, y: workArea.y + FLOAT_MARGIN },
    size,
    workArea
  )
}

/**
 * Which display the bar belongs to: the one holding most of it, falling back to
 * the primary display when the saved position is stale (a monitor was unplugged).
 */
export function resolveWorkArea(displays, bounds, primary) {
  if (!Array.isArray(displays) || displays.length === 0) return primary.workArea
  let best = null
  let bestOverlap = 0
  for (const display of displays) {
    const { x, y, width, height } = display.workArea
    const overlapX = Math.max(0, Math.min(bounds.x + bounds.width, x + width) - Math.max(bounds.x, x))
    const overlapY = Math.max(0, Math.min(bounds.y + bounds.height, y + height) - Math.max(bounds.y, y))
    const overlap = overlapX * overlapY
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      best = display
    }
  }
  return (best ?? primary).workArea
}
