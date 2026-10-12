// An applied strategy's run (appliedRun.js): its signals and option trades in the server scanner's record, on its own
// index, from when its setting was applied - what the "Applied now" card shows, and where "See the run" goes.
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runOf, runLink } from '../src/appliedRun.js'

const appliedAt = Date.parse('2026-10-12T10:00:00+05:30')
const rec = {
  signals: [
    { underlying: 'NIFTY', strategy_id: 'spotWallBreak', time_ist: '2026-10-12 09:40:00' }, // before it was applied
    { underlying: 'NIFTY', strategy_id: 'spotWallBreak', time_ist: '2026-10-12 10:45:00' },
    { underlying: 'NIFTY', strategy_id: 'spotWallBreak', time_ist: '2026-10-12 11:30:00' },
    { underlying: 'BANKNIFTY', strategy_id: 'spotWallBreak', time_ist: '2026-10-12 10:50:00' }, // another index
    { underlying: 'NIFTY', strategy_id: 'wallBreak', time_ist: '2026-10-12 10:46:00' }, // another strategy
  ],
  trades: [
    { underlying: 'NIFTY', strategy_id: 'spotWallBreak', entry_time_ist: '2026-10-12 09:40:00', exit_time_ist: '2026-10-12 09:50:00', live: 'false', net_rupees: '-900' },
    { underlying: 'NIFTY', strategy_id: 'spotWallBreak', entry_time_ist: '2026-10-12 10:45:00', exit_time_ist: '2026-10-12 10:53:00', live: 'true', net_rupees: '1450.5' },
    { underlying: 'NIFTY', strategy_id: 'spotWallBreak', entry_time_ist: '2026-10-12 11:30:00', exit_time_ist: '2026-10-12 11:41:00', live: 'false', net_rupees: '', rupees: '-300' },
    { underlying: 'NIFTY', strategy_id: 'spotWallBreak', entry_time_ist: '2026-10-12 13:05:00', exit_time_ist: '', live: 'false', net_rupees: '' },
  ],
}

test('the run since it was applied: its own index and strategy only, open trades apart, net after charges', () => {
  const r = runOf(rec, 'NIFTY', 'spotWallBreak', appliedAt)
  assert.equal(r.signals, 2)
  assert.equal(r.trades, 3)
  assert.equal(r.live, 1)
  assert.equal(r.open, 1)
  assert.equal(r.closed, 2)
  assert.equal(r.wins, 1)
  assert.equal(r.net, 1450.5 - 300, 'net rupees, else the gross when a row has no net')
  assert.equal(r.lastMs, Date.parse('2026-10-12T13:05:00+05:30'))
  // Applied before the time was kept: every day.
  const all = runOf(rec, 'NIFTY', 'spotWallBreak', null)
  assert.equal(all.signals, 3)
  assert.equal(all.trades, 4)
  assert.equal(all.net, -900 + 1450.5 - 300)
  // Nothing recorded yet.
  assert.deepEqual(runOf({ signals: [], trades: [] }, 'SENSEX', 'spotWallBreak', appliedAt), { signals: 0, trades: 0, live: 0, open: 0, closed: 0, wins: 0, net: 0, lastMs: null })
  assert.equal(runOf(null, 'NIFTY', 'x').trades, 0)
})

test('"See the run" opens the Scanner record filtered to it, from when it was applied', () => {
  const q = new URLSearchParams(runLink('NIFTY', 'spotWallBreak', appliedAt).split('?')[1])
  assert.equal(q.get('tab'), 'record')
  assert.equal(q.get('index'), 'NIFTY')
  assert.equal(q.get('strategy'), 'spotWallBreak')
  assert.equal(q.get('kind'), 'trades')
  assert.equal(Number(q.get('since')), appliedAt)
  assert.equal(new URLSearchParams(runLink('NIFTY', 'x').split('?')[1]).get('since'), null)
})
