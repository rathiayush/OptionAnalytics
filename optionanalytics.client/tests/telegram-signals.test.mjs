// The Telegram signals page (telegramSignals.js): each message the app sends read back as its index, kind, direction and
// price - the exact texts the code sends - a Telegram Desktop export read the same way, and the price reaction after a
// signal on the index's 1-minute bars (base = the price when it went, nothing from before it counted as after; moves in the
// signal's direction; best / worst in the hour), the summary and the CSV.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_KINDS, HORIZONS, barsOf, dayKeysOf, messageIndex, messagesToSignals, parseMessage, parseTelegramExport, reaction, reactionSummary, reactionsCsv, correlation } from '../src/telegramSignals.js'
import { entryText, exitText } from '../src/signalLive.js'

const MIN = 60_000
const at = (hhmmss) => Date.parse(`2026-11-12T${hhmmss}+05:30`)
const read = (text, time = at('10:32:20')) => parseMessage(text, time)
const kindDir = (text) => { const [s] = read(text); return [s.kind, s.dir, s.index] }

test('each message the code sends: its kind, direction and index', () => {
  // The server's iceberg / big order Telegram (OrderFlowTelegramAlerts - the C# tests hold these texts).
  const ice = read('🧊 Iceberg NIFTY futures: hidden BUYER at the bid 24500 · 120 lots traded there (15 shown at most) · 3 refills · still active · 10:00:02')
  assert.deepEqual([ice[0].kind, ice[0].dir, ice[0].index, ice[0].price], ['iceberg', 1, 'NIFTY', 24500])
  assert.deepEqual(kindDir('🧊 Iceberg BANKNIFTY futures: hidden SELLER at the offer 55210 · 60 lots traded there (8 shown at most) · ended · 11:00:00'), ['iceberg', -1, 'BANKNIFTY'])
  const big = read('🐋 Big order SENSEX futures: SELL 150 lots @ 82012.5 · 10:31:05', at('10:31:20'))
  assert.deepEqual(big.map((s) => [s.kind, s.dir, s.index, s.price, s.time, s.lots]), [['bigOrder', -1, 'SENSEX', 82012.5, at('10:31:05'), 150]])
  // Several prints in one message: a signal each, at its own time.
  const many = read('🐋 Big orders NIFTY futures: 2 prints - bought 200 lots, sold 120 lots\nSELL 120 lots @ 24510 · 10:00:05\nBUY 200 lots @ 24511 · 10:00:06', at('10:00:23'))
  assert.deepEqual(many.map((s) => [s.dir, s.price, s.time]), [[-1, 24510, at('10:00:05')], [1, 24511, at('10:00:06')]])
  // OI totals breaks and 🎯 (the page's and the server's, tagged [Server]).
  const brk = read('[Server] 🧱 NIFTY OI PE cumulative Δ broke above resistance +12.5L at 10:30 (put writing - bullish) · now +13.1L 🟢')
  assert.deepEqual([brk[0].kind, brk[0].dir, brk[0].index, brk[0].server], ['oiBreak', 1, 'NIFTY', true])
  assert.deepEqual(kindDir('🧱 BANKNIFTY OI CE cumulative Δ broke above resistance +3.2L at 11:15 (call writing - bearish) · now +3.4L 🔴'), ['oiBreak', -1, 'BANKNIFTY'])
  assert.deepEqual(kindDir('🎯 HIGH PROBABILITY BEARISH · NIFTY at 10:33\n• OI CE cumulative Δ broke above resistance +4.0L at 10:31 (call writing - bearish)'), ['highProb', -1, 'NIFTY'])
  assert.deepEqual(kindDir('🧱 Sudden OI wall - NIFTY PE 24500 +18.2L: support'), ['suddenWall', 1, 'NIFTY'])
  // The strategy scanner: a signal, a paper trade, a live order - and their exits (no direction).
  assert.deepEqual(kindDir('[Server] NIFTY #5 OI flip LONG - futures 24550.0 (SL 24520.0, target 24610.0)'), ['scanner', 1, 'NIFTY'])
  assert.deepEqual(kindDir('[Server] Paper BUY NIFTY 24500 PE x1 lot(s) @ 120.5 - #7 Wall break SHORT, futures 24480.0 (SL 24510.0, target 24420.0); option SL 20 / target 30 pts'), ['paper', -1, 'NIFTY'])
  assert.deepEqual(kindDir('LIVE order placed: SELL NIFTY 24500 PE x2 lot(s) @ ~85.0 - #3 Absorption LONG, futures 24510.0'), ['liveOrder', 1, 'NIFTY'])
  assert.equal(read('[Server] NIFTY Target hit: #5 OI flip LONG - entry 24550.0, out 24610.0 (+2.00R)')[0].kind, 'exit')
  assert.equal(read('Paper exit - Stop: sold NIFTY 24500 CE x1 @ 120.0 -> 100.0 = -20.0 pts, Rs -1,300 (#5 OI flip)')[0].kind, 'exit')
  // A saved strategy's live scan (signalLive.js's own texts): the entry has a direction, the exit none.
  const t = { action: 'BUY', strike: 24500, side: 'PE', entry: 120, entryTime: at('10:31:00'), why: 'Buy PE: total OI CE above PE', strategy: 'rule', exit: 140, exitTime: at('10:50:00'), exitReason: 'Target', points: 20, net: 1200, charges: 50 }
  assert.deepEqual(kindDir(entryText('VWAP flip', 'NIFTY', t)), ['strategy', -1, 'NIFTY'])
  assert.equal(read(exitText('VWAP flip', 'NIFTY', t))[0].kind, 'exit')
  // The server's own alerts.
  assert.deepEqual(kindDir('[Confluence] NIFTY BULLISH confluence\nspot + ATM CE + ATM PE agree\nSpot: 24,512.30 · ATM 24500'), ['confluence', 1, 'NIFTY'])
  assert.deepEqual(kindDir('🔔 Price alert: BANKNIFTY futures fell to 55100 (now 55098.4)'), ['price', -1, 'BANKNIFTY'])
  // A profile alert names its market, not the index - its price says which; no direction (a level reached).
  const prof = read('[Server] 📊 futures 24512.0 reached POC + VAH 24510.0 (volume + market profile confluence)')
  assert.deepEqual([prof[0].kind, prof[0].dir, prof[0].index, prof[0].guessed], ['profile', 0, 'NIFTY', true])
  assert.equal(read('📊 VWAP flip · NIFTY · Thu 12 Nov\nNo trades today.')[0].kind, 'exit')
  assert.equal(read('🔬 Feature finder done - run 1')[0].kind, 'exit')
  // "NIFTY" never read inside "BANKNIFTY"; a message about nothing has no index.
  assert.deepEqual(messageIndex('BANKNIFTY 55000'), { index: 'BANKNIFTY', guessed: false })
  assert.deepEqual(messageIndex('kill switch'), { index: null, guessed: false })
  assert.ok(DEFAULT_KINDS.includes('iceberg') && !DEFAULT_KINDS.includes('exit'))
})

test('a Telegram Desktop export of the channel reads the same - its text pieces joined, its unix time used', () => {
  const exp = {
    name: 'Signals', type: 'public_channel',
    messages: [
      { id: 1, type: 'service', date: '2026-11-12T09:00:00', date_unixtime: '1762918200', action: 'create_channel' },
      { id: 2, type: 'message', date: '2026-11-12T10:00:02', date_unixtime: String(at('10:00:02') / 1000), text: '🧊 Iceberg NIFTY futures: hidden BUYER at the bid 24500 · 120 lots traded there (15 shown at most) · still active · 10:00:02' },
      { id: 3, type: 'message', date: '2026-11-12T10:33:00', text: [{ type: 'bold', text: '🎯 HIGH PROBABILITY BULLISH' }, ' · NIFTY at 10:33'] },
    ],
  }
  const messages = parseTelegramExport(exp)
  assert.deepEqual(messages.map((m) => [m.time, m.text.slice(0, 12)]), [[at('10:00:02'), '🧊 Iceberg N'], [at('10:33:00'), '🎯 HIGH PROB']])
  const signals = messagesToSignals(messages)
  assert.deepEqual(signals.map((s) => [s.kind, s.dir]), [['iceberg', 1], ['highProb', 1]])
  assert.deepEqual(dayKeysOf(signals), ['NIFTY|2026-11-12'])
  assert.deepEqual(parseTelegramExport({}), [])
})

// The index's bars from 10:00: a rise of 2 points a minute, from 24500.
const spotDay = { bars: Array.from({ length: 120 }, (_, k) => { const c = 24500 + 2 * k; return { time: new Date(at('10:00:00') + k * MIN).toISOString(), open: c - 1, high: c + 1, low: c - 3, close: c } }) }
const bars = barsOf(spotDay)

test('the reaction: the price when it went, the moves after in its direction, the best / worst in the hour', () => {
  // A bullish signal at 10:10:20: base = the 10:09 close (24518 - the last minute completed); at +5 the 10:14 close.
  const bull = reaction({ time: at('10:10:20'), dir: 1 }, bars)
  assert.equal(bull.base, 24518)
  assert.deepEqual(HORIZONS.map((h) => bull.moves[h]), [10, 30, 60, 120])     // 10:14 24528, 10:24 24548, 10:39 24578, 11:09 24638
  assert.deepEqual(HORIZONS.map((h) => bull.signed[h]), [10, 30, 60, 120])
  assert.equal(Math.round(bull.pct[60] * 1000) / 1000, Math.round((120 / 24518) * 100 * 1000) / 1000)
  assert.equal(bull.best, 24520 + 2 * 59 + 1 - 24518)                       // the 11:09 high
  assert.equal(bull.worst, 24518 - (24520 - 3))                              // the 10:10 low
  assert.equal(bull.complete, true)
  // The same moves against a bearish signal; its best is the most it fell.
  const bear = reaction({ time: at('10:10:20'), dir: -1 }, bars)
  assert.deepEqual(HORIZONS.map((h) => bear.signed[h]), [-10, -30, -60, -120])
  assert.equal(bear.best, 24518 - 24517)
  // No direction: no signed move, the raw ones still.
  const none = reaction({ time: at('10:10:20'), dir: 0 }, bars)
  assert.equal(none.signed[15], null)
  assert.equal(none.moves[15], 30)
  // Late in the data: the horizons past its end are not there yet.
  const late = reaction({ time: at('11:45:00'), dir: 1 }, bars)
  assert.equal(late.moves[5], 10)
  assert.equal(late.moves[30], null)
  assert.equal(late.complete, false)
  // Nothing after the signal is its base: at 10:10:00 exactly, the 10:09 close (completed at 10:10:00).
  assert.equal(reaction({ time: at('10:10:00'), dir: 1 }, bars).base, 24518)
  // Before the first bar (09:15 - the data starts at 10:00) or with no bars: none.
  assert.equal(reaction({ time: at('09:20:00'), dir: 1 }, bars), null)
  assert.equal(reaction({ time: at('10:10:00'), dir: 1 }, []), null)
})

test('the summary per kind and the CSV', () => {
  const rows = [
    { time: at('10:10:20'), index: 'NIFTY', kind: 'iceberg', dir: 1, text: 'a', reaction: reaction({ time: at('10:10:20'), dir: 1 }, bars) },
    { time: at('10:20:20'), index: 'NIFTY', kind: 'iceberg', dir: -1, text: 'b', reaction: reaction({ time: at('10:20:20'), dir: -1 }, bars) },
    { time: at('10:30:20'), index: 'NIFTY', kind: 'profile', dir: 0, text: 'c', reaction: reaction({ time: at('10:30:20'), dir: 0 }, bars) },
  ]
  const [ice] = reactionSummary(rows)
  assert.equal(reactionSummary(rows).length, 1)                                // no direction: not in the summary
  assert.deepEqual([ice.kind, ice.signals, ice.bullish, ice.bearish], ['iceberg', 2, 1, 1])
  assert.equal(ice.avgPts15, 0)                                                // +30 and −30
  assert.equal(ice.hit15, 50)
  const csv = reactionsCsv(rows).split('\n')
  assert.equal(csv[0].split(',').slice(0, 6).join(','), 'time_ist,index,kind,direction,status,price_at_signal')
  assert.ok(csv[1].startsWith('2026-11-12 10:10:20,NIFTY,iceberg,bullish,,24518,10,30,60,120,10,30,60,120,'))
  assert.equal(csv.length, 4)
})

test('the correlation of a signal\'s side with the move after it, and the All signals row', () => {
  assert.equal(Math.round(correlation([1, 2, 3], [2, 4, 6]) * 1e9) / 1e9, 1)
  assert.equal(Math.round(correlation([1, 2, 3], [6, 4, 2]) * 1e9) / 1e9, -1)
  assert.equal(correlation([1, 1, 1], [1, 2, 3]), null)                       // one side only: says nothing
  assert.equal(correlation([1, -1], [1, -1]), null)                            // under 3
  // A V: down 2 points a minute from 10:00 to 10:40, then up 2 a minute.
  const v = barsOf({ bars: Array.from({ length: 120 }, (_, k) => { const c = 24500 + 2 * Math.abs(k - 40) - 80; return { time: new Date(at('10:00:00') + k * MIN).toISOString(), open: c, high: c + 1, low: c - 1, close: c } }) })
  const row = (time, kind, dir) => ({ time: at(time), index: 'NIFTY', kind, dir, text: '', reaction: reaction({ time: at(time), dir }, v) })
  // Bearish into the fall, bullish into the rise: the side matches what came next.
  const right = [row('10:05:10', 'iceberg', -1), row('10:12:10', 'iceberg', -1), row('10:45:10', 'iceberg', 1), row('10:50:10', 'bigOrder', 1), row('10:08:10', 'bigOrder', -1)]
  const [ice, big, every] = reactionSummary(right)
  assert.ok(ice.corr5 > 0.9 && ice.corr15 > 0.9, `iceberg ${ice.corr5} ${ice.corr15}`)
  assert.deepEqual([every.kind, every.signals, every.bullish, every.bearish], ['all', 5, 2, 3])
  assert.ok(every.corr15 > 0.9)
  assert.equal(big.signals, 2)
  // The same signals with their sides the other way: the correlation turns negative.
  const wrong = right.map((r) => ({ ...r, dir: -r.dir, reaction: reaction({ time: r.time, dir: -r.dir }, v) }))
  const allWrong = reactionSummary(wrong).at(-1)
  assert.ok(allWrong.corr15 < -0.9)
  assert.ok(allWrong.hit15 < 50)
  // One kind alone: no All row.
  assert.equal(reactionSummary(right.filter((r) => r.kind === 'iceberg')).length, 1)
})
