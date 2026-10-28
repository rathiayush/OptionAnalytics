# WIP: OI Replay dashboard - drag / resize / scrollbars

Branch `dashboard-fix`. **Incomplete - does not build-verify yet.** Picked up from the report:
"not able to move cards, want to set any width/height, move freely, and every card now has a scrollbar".

## What was diagnosed (reproduced in a real browser, `vite preview` + Playwright)

1. **Drag is NOT broken.** It works fine once cards are not full width (proved: a card moved x:0 -> x:6
   and persisted). It only *looks* dead because the shipped default layout gives every card `w: 12`,
   so there is nowhere sideways to go and vertical compaction snaps a downward drag back.
2. **Resize IS broken.** The resize corner is a child of the grid item, pinned bottom-right. The grid item
   had `overflow: auto`, so the corner sat *underneath the card's own scrollbar* and the scrollbar
   swallowed the mousedown. A drag of the corner changed nothing (measured: layout unchanged after
   +200/+180px). The library's corner chevron is also `rgba(0,0,0,0.4)` - invisible on a dark card.
3. **Scrollbars everywhere** because `CARD_ROWS` default heights are shorter than the real content
   (measured: dayOi needs 705px in 582, oiHeatmap 1135 in 766, spotAndEntry 1200 in 1042).

## Done on this branch

- `dashboardLayout.js`
  - `CARD_SPAN` / `defaultSpan(id)`; `defaultLayout` now packs cards left-to-right by span and wraps
    (full width only for topStats, entryChecklist, oiHeatmap, spotAndEntry, futures) - a real dashboard.
  - `isStackedLayout(layout, cardIds)` - detects the old all-`w:12` saved layout.
  - `fitLayoutHeights(layout, measured, sized)` - pure; sets each not-hand-sized card's `h` to what its
    content measured, returns the same array when nothing changed.
  - new keys `STORED_SIZED`, `STORED_LAYOUT_VERSION`, `LAYOUT_VERSION`.
- `DashboardCard.jsx` - rewritten. Content now lives in an inner `.oa-dash-body`, so the resize corner is
  no longer inside the scrolling box. Two modes: AUTO (measured with a ResizeObserver, height context
  null so charts stand at their own height - that is what stops the measure/fill feedback loop) and
  SIZED (card keeps its height, body scrolls, charts fill it).
- `DashboardGrid.jsx` - `onResizeCard` prop fired from `onResizeStop`; `preventCollision` now always
  false (it was the reason a card dropped on an occupied cell sprang back).
- `OiReplayPage.jsx` - imports; one-time `migrateStackedLayout()` (drops a saved all-full-width layout
  once so the new default takes over, guarded by `LAYOUT_VERSION`); `sizedCards` / `measured` /
  `onMeasure` / `onResizeCard` / `fitAllHeights` state; `dash(id)` now passes `auto` and `onMeasure`.

## Still TO DO

1. **`OiReplayPage.jsx` controls** (the edit that did not land - re-apply by hand):
   - add before the Reset button:
     `<Tooltip title="Every card back to exactly the height its own content needs..."><Button size="small" onClick={fitAllHeights} disabled={!sized.size}>Fit heights</Button></Tooltip>`
   - Reset should also clear the hand-sizes:
     `onClick={() => { setStoredLayout(null); fitAllHeights() }}`
     `disabled={isDefaultLayout(gridLayout, OI_REPLAY_CARD_IDS, cardOrder) && !sized.size}`
   - pass `onResizeCard={onResizeCard}` to `<DashboardGrid ...>` (~line 6075).
2. **`oiMobile.css`** - not touched yet, and this is the actual fix for (2) and (3):
   - `.react-grid-item.oa-dash-card { overflow: hidden; }`  (was `auto`)
   - `.oa-dash-body { width: 100%; }`
   - `.react-grid-item > .oa-dash-body { height: 100%; overflow: auto; }`
   - `.react-grid-item > .oa-dash-body.oa-dash-body--auto { height: auto; overflow: visible; }`
   - make the corner visible and big: `.react-grid-item > .react-resizable-handle { width: 26px;
     height: 26px; opacity: .35; z-index: 5 }`, `:hover`/editing -> `opacity: 1`, and `::after`
     `right/bottom: 5px; width/height: 11px; border-right/bottom: 2px solid #1677ff`.
   - the existing `.oa-dash-card > .ant-card` rule is dead (LiveSection's `display:contents` div sits
     between them) and is now one level further out again.
3. **Tests** - `tests/dashboard-layout.test.mjs` will FAIL: two tests assert the old full-width-stacked
   default ("the page starts with every card full width..." and the order test's `y` values). Update them
   to the span-packed default, and add tests for `fitLayoutHeights` (not-sized card follows the measured
   px, a sized one does not, same array back when nothing changed) and `isStackedLayout`.
4. `npm test`, `npm run lint`, `npx vite build` - none run since these edits.
5. Re-verify in the browser: drag, resize (the corner must now respond), and that no card scrolls on load.
   Harness: `npx vite preview --port 4179` then the scripts in the session scratchpad (`diag.mjs`,
   `diag3.mjs`) - they mock `/api` from `tests/synthetic-day.mjs`, no Dhan.
6. `CLAUDE.md`'s dashboard section needs the two card modes and "Fit heights" added.
