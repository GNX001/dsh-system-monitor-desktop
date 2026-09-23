/**
 * Dock geometry and the auto-hide state machine.
 *
 * Deliberately pure: no Electron import, no timers, no DOM. `main/index.js`
 * feeds it a cursor position and a clock and applies whatever it decides, which
 * is what makes the tricky part — "is the pointer reaching for a bar that is
 * almost entirely off-screen?" — testable without opening a window.
 *
 * The docked bar spans the **full work-area width** at the very top. Hidden, it
 * slides up so only {@link PEEK_PX} pixels remain visible; the pointer is not
 * over that sliver, it is over whatever is behind it, so reveal has to be driven
 * by the global cursor position rather than by DOM hover events.
 */

/** How many pixels of the bar stay visible while it is hidden at the top edge. */
export const PEEK_PX = 6

/** Extra pixels below the sliver that still count as reaching for the bar. */
export const GRAB_SLACK_PX = 2

/** How long the pointer must stay away before the bar hides itself again. */
export const COLLAPSE_DELAY_MS = 600

/** Gap between the floating bar and the work-area edges, in pixels. */
const FLOAT_MARGIN = 12

/**
 * Bounds for the docked bar.
 * @param workArea - the display's work area (taskbar already excluded).
 * @param barHeight - the bar's own height in CSS pixels.
 * @param expanded - true to show the bar, false to leave only the sliver.
 */
export function dockedBounds(workArea, barHeight, expanded) {
  const height = Math.max(1, Math.round(barHeight))
  return {
    x: Math.round(workArea.x),
    y: expanded ? Math.round(workArea.y) : Math.round(workArea.y - (height - PEEK_PX)),
    width: Math.round(workArea.width),
    height,
  }
}

/**
 * Whether the pointer is on the part of the docked bar that is actually visible.
 *
 * Hidden, that is the sliver (plus a little slack) — the pointer can never reach
 * the rest, because the OS will not deliver a position above the work area.
 * Visible, it is the whole bar, which is what keeps it open while in use.
 *
 * @param cursor - absolute screen point (`screen.getCursorScreenPoint()`).
 * @param workArea - the display's work area.
 * @param barHeight - the bar's height.
 * @param expanded - whether the bar is currently shown.
 */
export function isCursorOverBar(cursor, workArea, barHeight, expanded) {
  if (cursor === null || cursor === undefined) return false
  if (cursor.x < workArea.x || cursor.x >= workArea.x + workArea.width) return false
  const bottom = expanded
    ? workArea.y + Math.max(1, Math.round(barHeight))
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
 * @param input - `{ cursor, workArea, barHeight, now, pinned, collapseDelayMs }`.
 * @returns the next state (the same object when nothing changed).
 */
export function reduceDockState(state, input) {
  const collapseDelayMs = input.collapseDelayMs ?? COLLAPSE_DELAY_MS
  const now = input.now

  // Unpinned bars float and never auto-hide.
  if (input.pinned !== true) {
    return state.expanded === true ? state : { expanded: true, lastOverAt: now }
  }

  if (isCursorOverBar(input.cursor, input.workArea, input.barHeight, state.expanded)) {
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
