// Price alerts: an 'above' alert fires at or over its level, a 'below' one at or under it.
// Run: npm test (node --test) - see CLAUDE.md.
import { alertsHit } from '../src/alerts.js'
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }
const alerts = [{ id: 'a', price: 22850, dir: 'above' }, { id: 'b', price: 22700, dir: 'below' }]
check('nothing between the levels', alertsHit(alerts, 22780).length === 0)
check('above: fires at the level', alertsHit(alerts, 22850).map((a) => a.id).join() === 'a')
check('above: fires past it (a gap through the level)', alertsHit(alerts, 22861.5).map((a) => a.id).join() === 'a')
check('below: fires at / under the level', alertsHit(alerts, 22700).map((a) => a.id).join() === 'b' && alertsHit(alerts, 22650).map((a) => a.id).join() === 'b')
check('no price yet: nothing', alertsHit(alerts, null).length === 0 && alertsHit(alerts, 0).length === 0)
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
