import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COLLAPSE_DELAY_MS,
  GRAB_SLACK_PX,
  PEEK_PX,
  clampFloatingPosition,
  defaultFloatingPosition,
  dockedBounds,
  initialDockState,
  isCursorOverBar,
  reduceDockState,
  resolveWorkArea,
} from '../src/main/docking.js'

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 }
const BAR_HEIGHT = 34

test('docked bounds span the work area and leave a sliver when hidden', () => {
  const expanded = dockedBounds(WORK_AREA, BAR_HEIGHT, true)
  assert.deepEqual(expanded, { x: 0, y: 0, width: 1920, height: BAR_HEIGHT })

  const hidden = dockedBounds(WORK_AREA, BAR_HEIGHT, false)
  assert.equal(hidden.x, 0)
  assert.equal(hidden.width, 1920)
  // Only PEEK_PX rows of the bar stay on screen.
  assert.equal(hidden.y + hidden.height, PEEK_PX, 'the visible part is exactly the peek')
  assert.equal(hidden.y, -(BAR_HEIGHT - PEEK_PX))
})

test('docked bounds respect a work area that is not at the origin', () => {
  // A second monitor to the left, with the taskbar on the primary.
  const secondary = { x: -1920, y: 40, width: 1920, height: 1000 }
  assert.deepEqual(dockedBounds(secondary, 30, true), { x: -1920, y: 40, width: 1920, height: 30 })
  assert.equal(dockedBounds(secondary, 30, false).y, 40 - (30 - PEEK_PX))
})

test('a hidden bar is grabbed at the top edge, an open one anywhere on it', () => {
  // Hidden: only the sliver (plus slack) counts.
  assert.equal(isCursorOverBar({ x: 900, y: 0 }, WORK_AREA, BAR_HEIGHT, false), true)
  assert.equal(isCursorOverBar({ x: 900, y: PEEK_PX - 1 }, WORK_AREA, BAR_HEIGHT, false), true)
  assert.equal(isCursorOverBar({ x: 900, y: PEEK_PX + GRAB_SLACK_PX }, WORK_AREA, BAR_HEIGHT, false), false)
  assert.equal(isCursorOverBar({ x: 900, y: 200 }, WORK_AREA, BAR_HEIGHT, false), false)

  // Open: the whole bar keeps it open, so using it does not make it vanish.
  assert.equal(isCursorOverBar({ x: 900, y: 20 }, WORK_AREA, BAR_HEIGHT, true), true)
  assert.equal(isCursorOverBar({ x: 900, y: BAR_HEIGHT + 1 }, WORK_AREA, BAR_HEIGHT, true), false)

  // Outside the bar horizontally (another monitor, or beside a narrower bar).
  assert.equal(isCursorOverBar({ x: 3000, y: 0 }, WORK_AREA, BAR_HEIGHT, false), false)
  assert.equal(isCursorOverBar(null, WORK_AREA, BAR_HEIGHT, false), false)
})

test('the pointer reaching the top edge reveals the bar immediately', () => {
  const state = { expanded: false, lastOverAt: 0 }
  const next = reduceDockState(state, {
    cursor: { x: 100, y: 1 },
    workArea: WORK_AREA,
    barHeight: BAR_HEIGHT,
    now: 10_000,
    pinned: true,
  })
  assert.equal(next.expanded, true)
  assert.equal(next.lastOverAt, 10_000, 'the reveal timestamp is the moment it was seen')
})

test('hiding waits out the delay so brushing past the edge does not flap', () => {
  const open = { expanded: true, lastOverAt: 10_000 }
  const away = { cursor: { x: 100, y: 900 }, workArea: WORK_AREA, barHeight: BAR_HEIGHT, pinned: true }

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
    barHeight: BAR_HEIGHT,
    now: 5_000,
    pinned: false,
  })
  assert.equal(next.expanded, true)

  const already = initialDockState(1_000)
  assert.equal(
    reduceDockState(already, { cursor: null, workArea: WORK_AREA, barHeight: BAR_HEIGHT, now: 9_000, pinned: false }),
    already,
    'a steady state returns the identical object, so the caller can skip the redraw'
  )
})

test('an open bar stays open while the pointer is on it', () => {
  const open = { expanded: true, lastOverAt: 1_000 }
  const next = reduceDockState(open, {
    cursor: { x: 10, y: 5 },
    workArea: WORK_AREA,
    barHeight: BAR_HEIGHT,
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
