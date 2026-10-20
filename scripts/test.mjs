#!/usr/bin/env node
// Headless browser test (phone-sized, touch input). Needs Playwright + Chrome:
//   npm i -D playwright && npx playwright install chromium
//   BASE=http://localhost:8080/ node scripts/test.mjs        (default BASE: https://geekahedron.github.io/stickle/)
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'https://geekahedron.github.io/stickle/'
const U = 46, P = 12
const geom = (id) => { const [k, n] = id.split(':'), c = +n, mx = P + (c + 0.5) * U, mid = P + U
  return { v0: [P + c * U, P + U * 0.5], v1: [P + c * U, P + U * 1.5], h0: [mx, P], h1: [mx, mid], h2: [mx, P + 2 * U], lo: [mx, mid + U * 0.5], cv: [mx, mid] }[k] }
let fails = 0
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }

const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
for (const vw of [375, 414]) {
  const ctx = await b.newContext({ viewport: { width: vw, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  const pg = await ctx.newPage(), cdp = await ctx.newCDPSession(pg)
  const errs = [], foreign = []
  pg.on('pageerror', (e) => errs.push(String(e)))
  pg.on('request', (r) => { if (!r.url().startsWith(new URL(BASE).origin)) foreign.push(r.url()) })
  const touchDrag = async (x0, y0, x1, y1) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] })
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / 8, y: y0 + (y1 - y0) * i / 8 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await pg.waitForTimeout(500)
  }
  // board input is real touch through one CDP session; buttons are clicked (synthetic taps on buttons right after
  // a synthetic drag are flaky in headless Chrome, which isn't what's under test here)
  const tap = async (x, y) => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await pg.waitForTimeout(400) }
  const tapEl = async (loc) => { if (typeof loc === 'string') loc = pg.locator(loc); await loc.click(); await pg.waitForTimeout(400) }
  const slotXY = async (slot, width) => { const r = await pg.locator('.mboard').boundingBox(), s = r.width / (width * U + 2 * P), [gx, gy] = geom(slot); return [r.x + gx * s, r.y + gy * s] }
  const label = async () => pg.locator('.meta span').first().textContent()

  await pg.goto(BASE)
  ok(await pg.locator('[data-testid=help]').isVisible(), `${vw}px help opens on the first visit`)
  ok(/matches/.test(await pg.locator('[data-testid=help]').innerText()), `${vw}px help explains the game`)
  await tapEl('[data-testid=help-close]')
  const { today, num, day } = await pg.evaluate(() => { const t = localToday(); return { today: t, num: numberOf(t), day: dayFor(t) } })
  ok(day && (await label()) === `Stickle #${num}`, `${vw}px today (${today}, local date) is Stickle #${num}`)
  const fit = await pg.locator('.mboard').boundingBox(); ok(fit.x >= 0 && fit.x + fit.width <= vw, `${vw}px board fits the screen`)

  for (const [n, p] of day.puzzles.entries()) {
    const start = p.start.split(' '), ans = p.answer.split(' ')
    const rem = start.filter((s) => !ans.includes(s)), add = ans.filter((s) => !start.includes(s))
    if (n === 0) { // a wrong move first, then undo
      const [x0, y0] = await slotXY(rem[0], p.width), empty = (await pg.evaluate(() => empties())).find((s) => s.startsWith('h1')), [x1, y1] = await slotXY(empty, p.width)
      await touchDrag(x0, y0, x1, y1)
      ok((await pg.textContent('[data-testid=moves]')) === '1', `${vw}px a drag moves a match (counter 1)`)
      await tapEl(pg.getByText('Undo'))
      ok((await pg.textContent('[data-testid=moves]')) === '0', `${vw}px undo`)
    }
    for (let j = 0; j < rem.length; j++) {
      const [x0, y0] = await slotXY(rem[j], p.width), [x1, y1] = await slotXY(add[j], p.width)
      if (n === 1) { await tap(x0, y0); await tap(x1, y1) } else await touchDrag(x0, y0, x1, y1) // #2 by tap-then-tap
    }
    ok(await pg.locator('.okmsg').count() === 1, `${vw}px #${n + 1} ${p.goal.type}/${p.goal.moves} ${p.text} -> ${p.solution} solved by ${n === 1 ? 'tap+tap' : 'touch drag'}`)
    if (n < 2) { await tapEl(pg.getByText('Next puzzle')) }
  }
  const share = await pg.locator('.win pre').textContent()
  ok(share.startsWith(`Stickle #${num}`) && share.includes('🔥🔥🔥 3/3') && share.includes(`?p=${num}`), `${vw}px share text: ${JSON.stringify(share)}`)
  await pg.reload(); await pg.waitForSelector('.match')
  ok(await pg.locator('.tab.ok').count() === 3 && await pg.locator('.win').count() === 1, `${vw}px progress survives a reload (localStorage)`)

  await pg.goto(BASE + '#/archive'); await pg.waitForSelector('.alist a')
  const rows = await pg.locator('.alist a').count()
  ok(rows === num && (await pg.locator(`.alist a[data-date="${today}"] .astat`).textContent()) === '🔥🔥🔥', `${vw}px archive lists ${rows} days, today marked 🔥🔥🔥`)
  await tapEl('.alist a[data-date="2026-10-03"]'); await pg.waitForSelector('.match')
  ok((await label()) === 'Stickle #3', `${vw}px archive opens #3`)
  await tapEl(pg.getByText('Give up'))
  ok(/Revealed: 13-4=9/.test(await pg.locator('main').innerText()), `${vw}px give up shows the answer (13-4=9)`)
  await pg.goto(BASE + '?p=5'); await pg.waitForSelector('.match'); ok((await label()) === 'Stickle #5' && pg.url().endsWith('#/2026-10-05'), `${vw}px ?p=5 share link opens #5`)
  await pg.goto(BASE + '#/stickle/2026-10-02'); await pg.waitForSelector('.match'); ok((await label()) === 'Stickle #2', `${vw}px old #/stickle/<date> links work`)
  await pg.goto(BASE + '#/2099-01-01'); await pg.waitForTimeout(300); ok(/isn’t out yet/.test(await pg.locator('main').innerText()), `${vw}px future days are locked`)
  ok(!errs.length, `${vw}px no page errors ${errs.join(' | ')}`)
  ok(!foreign.length, `${vw}px no requests to other sites ${foreign.slice(0, 3)}`)
  await ctx.close()
}
// lookup by local date: fake the clock to a later day
{
  const ctx = await b.newContext(); const pg = await ctx.newPage()
  await ctx.clock.setFixedTime(new Date('2027-03-15T23:30:00'))
  await pg.goto(BASE); await pg.waitForSelector('.match')
  ok((await pg.locator('.meta span').first().textContent()) === 'Stickle #166' && (await pg.locator('.meta a').textContent()).startsWith('2027-03-15'), 'clock set to 2027-03-15 23:30 local: Stickle #166')
  await ctx.close()
}
await b.close()
console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0)
