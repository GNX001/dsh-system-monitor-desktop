import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COLLAPSE_DELAY_MS,
  GRAB_SLACK_PX,
  PEEK_PX,
  clampFloatingPosition,
  defaultFloatingPosition,
  dockedBounds,
  dockedX,
  initialDockState,
  isCursorOverBar,
  reduceDockState,
  resolveWorkArea,
} from '../src/main/docking.js'

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 }
/** The capsule's own size — narrower than the work area, which is the point. */
const BAR = { width: 900, height: 34 }
/** Centre of the docked bar, for cursor tests. */
const BAR_MID = dockedX(WORK_AREA, BAR.width) + Math.round(BAR.width / 2)

test('docked bounds keep the bar its own width, centred on the top edge', () => {
  const expanded = dockedBounds(WORK_AREA, BAR, true)
  assert.deepEqual(expanded, { x: 510, y: 0, width: 900, height: 34 })
  assert.notEqual(expanded.width, WORK_AREA.width, 'the bar is never stretched to the screen')

  const hidden = dockedBounds(WORK_AREA, BAR, false)
  assert.equal(hidden.x, 510, 'hiding does not move it sideways')
  assert.equal(hidden.width, 900, 'nor change its width')
  // Only PEEK_PX rows of the bar stay on screen.
  assert.equal(hidden.y + hidden.height, PEEK_PX, 'the visible part is exactly the peek')
  assert.equal(hidden.y, -(BAR.height - PEEK_PX))
})

test('a bar wider than its work area starts at the left edge instead of going negative', () => {
  const wide = { width: 3000, height: 34 }
  assert.equal(dockedX(WORK_AREA, wide.width), WORK_AREA.x)
  assert.equal(dockedBounds(WORK_AREA, wide, true).x, 0)
})

test('docked bounds respect a work area that is not at the origin', () => {
  // A second monitor to the left, with the taskbar on the primary.
  const secondary = { x: -1920, y: 40, width: 1920, height: 1000 }
  const bar = { width: 900, height: 30 }
  assert.deepEqual(dockedBounds(secondary, bar, true), { x: -1410, y: 40, width: 900, height: 30 })
  assert.equal(dockedBounds(secondary, bar, false).y, 40 - (30 - PEEK_PX))
})

test('a hidden bar is grabbed at the top edge, an open one anywhere on it', () => {
  // Hidden: only the sliver (plus slack) counts.
  assert.equal(isCursorOverBar({ x: BAR_MID, y: 0 }, WORK_AREA, BAR, false), true)
  assert.equal(isCursorOverBar({ x: BAR_MID, y: PEEK_PX - 1 }, WORK_AREA, BAR, false), true)
  assert.equal(isCursorOverBar({ x: BAR_MID, y: PEEK_PX + GRAB_SLACK_PX }, WORK_AREA, BAR, false), false)
  assert.equal(isCursorOverBar({ x: BAR_MID, y: 200 }, WORK_AREA, BAR, false), false)

  // Open: the whole bar keeps it open, so using it does not make it vanish.
  assert.equal(isCursorOverBar({ x: BAR_MID, y: 20 }, WORK_AREA, BAR, true), true)
  assert.equal(isCursorOverBar({ x: BAR_MID, y: BAR.height + 1 }, WORK_AREA, BAR, true), false)

  assert.equal(isCursorOverBar(null, WORK_AREA, BAR, false), false)
})

test('a bar that keeps its width is only grabbed where it actually is', () => {
  // The screen edge is not the bar: the top-left corner is somebody else's.
  assert.equal(isCursorOverBar({ x: WORK_AREA.x, y: 0 }, WORK_AREA, BAR, false), false)
  assert.equal(isCursorOverBar({ x: 200, y: 0 }, WORK_AREA, BAR, false), false)
  assert.equal(isCursorOverBar({ x: 3000, y: 0 }, WORK_AREA, BAR, false), false)

  // Its real edges do count, with GRAB_SLACK_PX of forgiveness each side.
  const left = dockedX(WORK_AREA, BAR.width)
  const right = left + BAR.width
  assert.equal(isCursorOverBar({ x: left, y: 0 }, WORK_AREA, BAR, false), true)
  assert.equal(isCursorOverBar({ x: left - GRAB_SLACK_PX, y: 0 }, WORK_AREA, BAR, false), true)
  assert.equal(isCursorOverBar({ x: left - GRAB_SLACK_PX - 1, y: 0 }, WORK_AREA, BAR, false), false)
  assert.equal(isCursorOverBar({ x: right - 1, y: 0 }, WORK_AREA, BAR, false), true)
  assert.equal(isCursorOverBar({ x: right + GRAB_SLACK_PX, y: 0 }, WORK_AREA, BAR, false), false)
})

test('the pointer reaching the top edge reveals the bar immediately', () => {
  const state = { expanded: false, lastOverAt: 0 }
  const next = reduceDockState(state, {
    cursor: { x: BAR_MID, y: 1 },
    workArea: WORK_AREA,
    bar: BAR,
    now: 10_000,
    pinned: true,
  })
  assert.equal(next.expanded, true)
  assert.equal(next.lastOverAt, 10_000, 'the reveal timestamp is the moment it was seen')
})

test('hiding waits out the delay so brushing past the edge does not flap', () => {
  const open = { expanded: true, lastOverAt: 10_000 }
  const away = { cursor: { x: BAR_MID, y: 900 }, workArea: WORK_AREA, bar: BAR, pinned: true }

  const tooEarly = reduceDockState(open, { ...away, now: 10_000 + COLLAPSE_DELAY_MS - 1 })
  assert.equal(tooEarly, open, 'nothing changes before the delay elapses')

  const late = reduceDockState(open, { ...away, now: 10_000 + COLLAPSE_DELAY_MS })
  assert.equal(late.expanded, false)
  assert.equal(late.lastOverAt, 10_000, 'hiding does not restart the timer')
})

test('an unpinned bar is always expanded and ignores the cursor', () => {
  const collapsed = { expanded: false, lastOverAt: 0 }
  const next = reduceDockState(collapsed, {
    cursor: { x: 0, y: 900 },
    workArea: WORK_AREA,
    bar: BAR,
    now: 5_000,
    pinned: false,
  })
  assert.equal(next.expanded, true)

  const already = initialDockState(1_000)
  assert.equal(
    reduceDockState(already, { cursor: null, workArea: WORK_AREA, bar: BAR, now: 9_000, pinned: false }),
    already,
    'a steady state returns the identical object, so the caller can skip the redraw'
  )
})

test('an open bar stays open while the pointer is on it', () => {
  const open = { expanded: true, lastOverAt: 1_000 }
  const next = reduceDockState(open, {
    cursor: { x: BAR_MID, y: 5 },
    workArea: WORK_AREA,
    bar: BAR,
    now: 1_000 + COLLAPSE_DELAY_MS * 5,
    pinned: true,
  })
  assert.equal(next.expanded, true)
  assert.equal(next.lastOverAt, 1_000 + COLLAPSE_DELAY_MS * 5)
})

test('a floating bar is clamped inside the work area', () => {
  const size = { width: 780, height: 34 }
  assert.deepEqual(clampFloatingPosition({ x: -500, y: -500 }, size, WORK_AREA), { x: 0, y: 0 })
  assert.deepEqual(clampFloatingPosition({ x: 9999, y: 9999 }, size, WORK_AREA), {
    x: WORK_AREA.width - size.width,
    y: WORK_AREA.height - size.height,
  })
  // Wider than the work area: pin to the left edge rather than going negative.
  assert.deepEqual(clampFloatingPosition({ x: 10, y: 10 }, { width: 3000, height: 34 }, WORK_AREA), { x: 0, y: 10 })
})

test('the default floating spot is inside the work area', () => {
  const size = { width: 780, height: 34 }
  const spot = defaultFloatingPosition(size, WORK_AREA)
  assert.ok(spot.x > WORK_AREA.width / 2, 'starts on the right')
  assert.ok(spot.y >= WORK_AREA.y, 'starts below the top edge')
  assert.ok(spot.x + size.width <= WORK_AREA.width)
})

test('the bar follows the display it is mostly on', () => {
  const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
  const secondary = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 1024 } }
  const displays = [primary, secondary]

  assert.equal(
    resolveWorkArea(displays, { x: 2000, y: 100, width: 700, height: 34 }, primary).x,
    1920,
    'a bar on the second monitor docks there'
  )
  assert.equal(resolveWorkArea(displays, { x: 100, y: 100, width: 700, height: 34 }, primary).x, 0)
  // A stale position from an unplugged monitor falls back to the primary.
  assert.equal(resolveWorkArea([primary], { x: 5000, y: 100, width: 700, height: 34 }, primary).x, 0)
  assert.equal(resolveWorkArea([], { x: 0, y: 0, width: 10, height: 10 }, primary).width, 1920)
})
