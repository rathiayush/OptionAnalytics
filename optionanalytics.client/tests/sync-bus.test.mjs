// Replay sync across devices (syncBus.js): this browser's tabs (BroadcastChannel) and the server relay (other devices)
// carry the same messages - each handed on ONCE, whichever way it came first; the device named; a closed bus hears nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSyncBus, deviceKind, makeDeduper } from '../src/syncBus.js'

// A shared "broadcast channel" between buses (every other member hears a post) and a "server" relaying to every other
// subscriber - the same message can reach a tab both ways.
function network() {
  const channels = new Set()
  const relays = new Set()
  const channel = () => {
    const c = { onmessage: null, postMessage(data) { for (const o of channels) if (o !== c) o.onmessage?.({ data: structuredClone(data) }) }, close() { channels.delete(c) } }
    channels.add(c)
    return c
  }
  const relay = () => {
    const handlers = new Set()
    const r = {
      send(msg) { for (const o of relays) if (o !== r) for (const h of o.handlers) h(structuredClone(msg)) },
      subscribe(h) { handlers.add(h); return () => handlers.delete(h) },
      handlers,
    }
    relays.add(r)
    return r
  }
  return { channel, relay }
}

test('a message reaches each tab once - this browser\'s tabs by the channel, another device by the server', () => {
  const laptop = network(), shared = network()
  // Laptop: two tabs, both on the channel and the relay (Devices on). Tablet: its own channel, the relay.
  const tabA = createSyncBus({ channel: laptop.channel(), relay: shared.relay(), from: 'a', dev: { id: 'L', name: 'Mac' } })
  const tabB = createSyncBus({ channel: laptop.channel(), relay: shared.relay(), from: 'b', dev: { id: 'L', name: 'Mac' } })
  const tablet = createSyncBus({ channel: network().channel(), relay: shared.relay(), from: 't', dev: { id: 'T', name: 'iPad' } })
  const got = { a: [], b: [], t: [] }
  tabA.onmessage = ({ data }) => got.a.push(data)
  tabB.onmessage = ({ data }) => got.b.push(data)
  tablet.onmessage = ({ data }) => got.t.push(data)

  tabA.postMessage({ type: 'state', ms: 1 })
  assert.equal(got.a.length, 0, 'never back to the sender')
  assert.equal(got.b.length, 1, 'the other tab once, though it came by the channel AND the server')
  assert.equal(got.t.length, 1)
  assert.equal(got.t[0].deviceName, 'Mac')
  assert.equal(got.t[0].device, 'L')
  assert.equal(got.t[0].ms, 1)

  tablet.postMessage({ type: 'day', date: '2026-11-16' })
  assert.deepEqual([got.a.length, got.b.length, got.t.length], [1, 2, 1])
  assert.equal(got.a[0].deviceName, 'iPad')

  // A tab with Devices off (no relay) still hears its own browser's tabs, not the tablet.
  const tabC = createSyncBus({ channel: laptop.channel(), from: 'c', dev: { id: 'L', name: 'Mac' } })
  const c = []
  tabC.onmessage = ({ data }) => c.push(data.type)
  tablet.postMessage({ type: 'presence' })
  tabA.postMessage({ type: 'tick' })
  assert.deepEqual(c, ['tick'])

  // Closed: nothing more.
  assert.equal(got.b.length, 4)
  tabB.close()
  tablet.postMessage({ type: 'state', ms: 2 })
  assert.equal(got.b.length, 4)
  assert.equal(got.a.length, 3)
  // Junk from the server is ignored.
  const junk = []
  const quiet = createSyncBus({ relay: { send() {}, subscribe: (h) => { setTimeout(() => { h(null); h('x') }); return () => {} } } })
  quiet.onmessage = ({ data }) => junk.push(data)
  return new Promise((done) => setTimeout(() => { assert.deepEqual(junk, []); done() }, 5))
})

test('the deduper keeps the last N ids', () => {
  const seen = makeDeduper(3)
  assert.equal(seen('a'), false)
  assert.equal(seen('a'), true)
  for (const id of ['b', 'c', 'd']) seen(id)
  assert.equal(seen('a'), false, 'forgotten after 3 more')
  assert.equal(seen(null), false)
  assert.equal(seen(null), false)
})

test('device names from the user agent', () => {
  assert.equal(deviceKind('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), 'iPad')
  assert.equal(deviceKind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', { touchPoints: 5 }), 'iPad')
  assert.equal(deviceKind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'Mac')
  assert.equal(deviceKind('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'iPhone')
  assert.equal(deviceKind('Mozilla/5.0 (Linux; Android 14; SM-S911B) Mobile Safari'), 'Android phone')
  assert.equal(deviceKind('Mozilla/5.0 (Linux; Android 14; SM-X710) Safari'), 'Android tablet')
  assert.equal(deviceKind('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'Windows PC')
  assert.equal(deviceKind('Mozilla/5.0 (X11; Linux x86_64)'), 'Linux PC')
  assert.equal(deviceKind(''), 'device')
})
