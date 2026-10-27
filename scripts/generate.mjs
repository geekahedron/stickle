#!/usr/bin/env node
// Stickle puzzle generator + verifier. Runs offline with plain Node (no dependencies) and rewrites the
// PUZZLES array in index.html. The engine is read straight out of index.html, so the game and the
// generator can never disagree about how a board reads.
//
//   node scripts/generate.mjs --days=30            add 30 days after the last puzzle
//   node scripts/generate.mjs --to=2027-12-31      add days up to a date
//   node scripts/generate.mjs --to=2027-12-31 --jobs=8   same, split over 8 worker processes
//   node scripts/generate.mjs --verify             re-check every puzzle in index.html (no writes)
//   node scripts/generate.mjs --selftest           fast evaluator vs engine on 100k random boards
//
// Each day gets 3 puzzles (deterministic per date) from a weekly plan of goal types and shapes. Every puzzle
// is checked by enumerating ALL boards reachable with <= k moves on the full lattice:
//   fix/target: exactly one solving board (as read; spacing variants count once), and none with fewer moves
//   max/min/minpos: exactly one board reaching the best value, which must beat the start
//                   (minpos = smallest value that is > 0; zero/negatives do not count)
// Stored puzzles are then widened by PAD empty columns on each side (room for an extra digit or a leading
// minus). For max/min/minpos the stored `best` and `answer` are recomputed by searching every board within <= k
// moves on that wider lattice (the player is scored against it). scripts/check-best.mjs re-checks with the engine.
//   node scripts/generate.mjs --widen              one-off: widen stored puzzles that have no `pad` yet
import fs from 'fs'
import { fileURLToPath } from 'url'

const HTML = fileURLToPath(new URL('../index.html', import.meta.url))
const html = fs.readFileSync(HTML, 'utf8')
const engineSrc = html.slice(html.indexOf('// /*ENGINE-BEGIN*/'), html.indexOf('// /*ENGINE-END*/'))
const E = new Function(engineSrc + '; return Engine')()
const PB = '/*PUZZLES-BEGIN*/', PE = '/*PUZZLES-END*/'
const PUZZLES = JSON.parse(html.slice(html.indexOf(PB) + PB.length, html.indexOf(PE)))
const EPOCH = html.match(/const EPOCH = '([\d-]+)'/)[1]
const arg = (k, d) => { const a = process.argv.find((x) => x === `--${k}` || x.startsWith(`--${k}=`)); return a ? (a.split('=')[1] ?? true) : d }

let seed = 1
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const pick = (a) => a[Math.floor(rnd() * a.length)]

function* combos(arr, k, s = 0, acc = []) {
  if (acc.length === k) { yield acc; return }
  for (let i = s; i < arr.length; i++) { acc.push(arr[i]); yield* combos(arr, k, i + 1, acc); acc.pop() }
}
function* neighbours(width, start, k) {
  const empty = E.slotsOf(width).filter((s) => !start.includes(s))
  for (let j = 1; j <= k; j++)
    for (const rem of combos(start, j)) {
      const keep = start.filter((x) => !rem.includes(x))
      for (const add of combos(empty, j)) yield { occ: [...keep, ...add], j }
    }
}

// ---- fast evaluator (integer slots, in-place) — cross-checked against the engine on every result ----
const SPANK = ['h0', 'h1', 'h2', 'lo', 'cv']
const idx = (W, id) => { const [k, n] = id.split(':'), x = +n; return k[0] === 'v' ? x * 2 + +k[1] : 2 * (W + 1) + x * 5 + SPANK.indexOf(k) }
const ids = (W) => E.slotsOf(W).sort((a, b) => idx(W, a) - idx(W, b))
const DIG = {}; for (const [p, d] of Object.entries(E.DIGITS)) { let m = 0; for (const ch of p) m |= 1 << 'abcdefg'.indexOf(ch); DIG[m] = d }
function fastGlyphs(W, o) {
  const V = 2 * (W + 1); let out = ''
  const link = (c) => { const b = V + c * 5; return o[b] | o[b + 1] | o[b + 2] | o[b + 3] | o[b + 4] }
  let x = 0
  while (x <= W) {
    const lk = x < W ? link(x) : 0
    if (!(o[2 * x] | o[2 * x + 1]) && !lk) { x++; continue }
    if (!lk) { if (o[2 * x] & o[2 * x + 1]) { out += '1'; x++; continue } return null }
    if (x + 1 < W && link(x + 1)) return null
    const b = V + x * 5, L0 = o[2 * x], L1 = o[2 * x + 1], R0 = o[2 * x + 2], R1 = o[2 * x + 3]
    if (o[b + 3] | o[b + 4]) {
      if (o[b] | o[b + 2] | L0 | L1 | R0 | R1) return null
      const key = (o[b + 1] ? 'g+' : '') + ['lo', 'cv'].filter((_, i) => o[b + 3 + i]).join('+')
      const sym = E.OPS[key]; if (!sym) return null; out += sym
    } else {
      const m = o[b] | (R0 << 1) | (R1 << 2) | (o[b + 2] << 3) | (L1 << 4) | (L0 << 5) | (o[b + 1] << 6)
      if (m === 64) out += '-'; else { const d = DIG[m]; if (!d) return null; out += d }
    }
    x += 2 // x+1 belongs to this group; the next group can start at x+2 at the earliest
  }
  return out
}
const toks = (g) => { const t = []; for (const ch of g) { if (ch >= '0' && ch <= '9' && t.length && /^\d/.test(t[t.length - 1])) t[t.length - 1] += ch; else t.push(ch) } return t }
const fastValue = (W, o) => { const g = fastGlyphs(W, o); if (g === null || g.includes('=')) return null; return E.evalExpr(toks(g)) }
const fastTrue = (W, o) => { const g = fastGlyphs(W, o); if (g === null) return false; const t = toks(g); const k = t.indexOf('='); if (k < 0 || t.lastIndexOf('=') !== k) return false; const l = E.evalExpr(t.slice(0, k)), r = E.evalExpr(t.slice(k + 1)); return l !== null && r !== null && l === r }
// visit every board within <=k moves; cb(o, j) returns true to stop
function visit(W, start, k, cb) {
  const all = ids(W), o = new Uint8Array(all.length), occ = start.map((s) => idx(W, s)); for (const i of occ) o[i] = 1
  const empty = [...all.keys()].filter((i) => !o[i]), snap = () => all.filter((_, i) => o[i])
  for (let j = 1; j <= k; j++) for (const rem of combos(occ, j)) { for (const r of rem) o[r] = 0
    for (const add of combos(empty, j)) { for (const a of add) o[a] = 1; const stop = cb(o, j, snap); for (const a of add) o[a] = 0; if (stop) { for (const r of rem) o[r] = 1; return } }
    for (const r of rem) o[r] = 1 }
}
function solveFix(width, start, k, cap = 1) {
  const sols = []
  const seen = new Set() // boards that read the same (different spacing) count as one answer
  visit(width, start, k, (o, j, snap) => { if (fastTrue(width, o)) { const g = fastGlyphs(width, o); if (seen.has(g)) { const s0 = sols.find((x) => x.text === g); if (s0 && j < s0.j) { s0.j = j; s0.occ = snap() } return false } seen.add(g); sols.push({ occ: snap(), j, text: g }); return sols.length > cap } })
  return sols
}
function allValues(width, start, k) {
  const vals = []
  visit(width, start, k, (o, j, snap) => { const v = fastValue(width, o); if (v !== null) vals.push({ v, j, text: fastGlyphs(width, o), occ: snap() }) ; return false })
  return vals
}
function selftest() { // fast evaluator vs engine on random/perturbed boards
  let bad = 0, n = 0; seed = 99
  for (let i = 0; i < 100000; i++) {
    let txt = [...Array(1 + Math.floor(rnd() * 7))].map((_, j) => (j % 2 && rnd() < 0.6 ? pick('+-=') : pick('0123456789'))).join(''); if (rnd() < 0.25) txt = '-' + txt; txt = txt.replace(/=/g, () => (rnd() < 0.3 ? '=-' : '='))
    const W = E.widthFor(txt); let occ = E.boardFrom(txt); const sl = E.slotsOf(W)
    for (let f = Math.floor(rnd() * 4); f > 0; f--) { const x = pick(sl); occ = occ.includes(x) ? occ.filter((y) => y !== x) : [...occ, x] }
    const o = new Uint8Array(sl.length); for (const s of occ) o[idx(W, s)] = 1
    const a = fastGlyphs(W, o), b = E.glyphs(W, occ); n++
    if ((a === null) !== (b === null) || (a !== null && a !== b.join(''))) { bad++; if (bad < 4) console.error('MISMATCH', txt, occ.join(' '), a, b) }
  }
  console.error(`selftest: ${n} boards, mismatches ${bad}`); if (bad) process.exit(1)
}
const distinct = (ns) => { const m = new Map(); for (const n of ns) { const o = m.get(n.text); if (!o || n.j < o.j) m.set(n.text, n) } return [...m.values()] }
const randDigits = (n) => [...Array(n)].map((_, i) => (i === 0 ? pick('123456789') : pick('0123456789'))).join('')
function randEquation(shape) { // shape like 'D+D=DD' -> true equation text
  for (let t = 0; t < 5000; t++) {
    const parts = shape.split(/([+\-x/=])/), txt = parts.map((p) => (/^D+$/.test(p) ? randDigits(p.length) : p)).join('')
    const w = E.widthFor(txt); if (E.isTrueEquation(w, E.boardFrom(txt))) return txt
  }
}
function shuffleMoves(width, occ, k) { // apply k random moves to a board
  let o = [...occ]
  const slots = E.slotsOf(width)
  for (let i = 0; i < k; i++) {
    const from = pick(o), empties = slots.filter((s) => !o.includes(s)), to = pick(empties)
    o = o.filter((x) => x !== from).concat(to)
  }
  return o
}
const usedStarts = new Set() // avoid repeating a start board across days
function make(type, k, shape, maxTries = type === 'fix' && k > 1 ? 120 : 400) {
  for (let tries = 0; tries < maxTries; tries++) {
    if (type === 'fix') {
      const truth = randEquation(pick(shape.split('|'))); if (!truth) continue
      const width = E.widthFor(truth)
      const okStart = (o) => { const t = E.tokenize(width, o); if (!t || t.filter((x) => x === '=').length !== 1) return false; const q = t.indexOf('='); return E.evalExpr(t.slice(0, q)) !== null && E.evalExpr(t.slice(q + 1)) !== null && !E.isTrueEquation(width, o) && E.moveCount(E.boardFrom(truth), o) === k } // a well-formed but false equation
      let start = null
      if (k === 1) { const c = [...neighbours(width, E.boardFrom(truth), 1)].map((n) => n.occ).filter(okStart); if (c.length) start = pick(c) }
      else for (let a = 0; a < 20000 && !start; a++) { const o = shuffleMoves(width, E.boardFrom(truth), k); if (okStart(o)) start = o }
      if (!start || usedStarts.has(E.render(width, start))) continue
      const sols = solveFix(width, start, k)
      if (sols.length === 1 && sols[0].j === k) return { goal: { type, moves: k }, width, start, startText: E.render(width, start), solution: E.render(width, sols[0].occ), solutionSlots: [...sols[0].occ].sort() }
    } else {
      const txt = shape.replace(/D/g, () => pick('0123456789')).replace(/^0/, '1')
      const width = E.widthFor(txt), start = E.boardFrom(txt), v0 = E.value(width, start)
      if (v0 === null || usedStarts.has(txt)) continue
      const vals = allValues(width, start, k)
      if (type === 'max' || type === 'min' || type === 'minpos') {
        const pool = type === 'minpos' ? vals.filter((n) => n.v > 0) : vals
        if (!pool.length) continue
        const best = type === 'max' ? Math.max(...pool.map((n) => n.v)) : Math.min(...pool.map((n) => n.v))
        const sols = distinct(pool.filter((n) => n.v === best))
        if (sols.length === 1 && (type === 'max' ? best > v0 : best < v0) && sols[0].j === k) return { goal: { type, moves: k }, width, start, startText: txt, best, solution: E.render(width, sols[0].occ), solutionSlots: [...sols[0].occ].sort() }
      } else {
        const by = new Map(); for (const n of distinct(vals)) by.set(n.v, [...(by.get(n.v) || []), n])
        const c = [...by.entries()].filter(([v, ns]) => v !== v0 && v >= -20 && v < 100 && ns.length === 1 && ns[0].j === k)
        if (!c.length) continue
        const [target, [n]] = pick(c)
        return { goal: { type, moves: k, target }, width, start, startText: txt, solution: E.render(width, n.occ), solutionSlots: [...n.occ].sort() }
      }
    }
  }
  throw new Error(`could not make ${type} ${k} ${shape}`)
}
// weekly rotation of (type, moves, shape); three per day, getting harder. Shapes: '|' = alternatives.
const PLAN = [
  [['fix', 1, 'D+D=D|D-D=D'], ['max', 1, 'DDD'], ['fix', 2, 'D+D=DD|DD-D=D']],
  [['min', 1, 'DDD'], ['target', 1, 'D-DD'], ['fix', 2, 'DD-D=DD']],
  [['fix', 1, 'DD-D=D|DD+D=DD'], ['max', 2, 'DDD'], ['target', 2, 'DD-DD']],
  [['max', 1, 'DDDD'], ['fix', 1, 'D+D=DD|DD-D=DD'], ['minpos', 2, 'DDDD']],
  [['target', 1, 'DD-D'], ['fix', 2, 'D+D=D|D-D=D'], ['max', 2, 'D+DDD']],
  [['fix', 1, 'DD+D=DD|DD-D=DD'], ['min', 2, 'DDD'], ['target', 2, 'D-D+D']],
  [['minpos', 1, 'DDDD'], ['fix', 2, 'DD+DD=DD|DD-DD=DD'], ['max', 2, 'DDDD']],
]
const day = (s) => Math.round(Date.parse(s + 'T00:00:00Z') / 864e5)
const iso = (n) => new Date(n * 864e5).toISOString().slice(0, 10)
const PAD = 2
const shift = (occ, d) => occ.map((s) => { const [k, n] = s.split(':'); return `${k}:${+n + d}` })
// best over the wide lattice: the extreme value; its board = fewest moves, then the narrow answer if it is one,
// then the smallest text/slots (deterministic)
function wideBest(type, W, start, k, narrowAns) {
  const vals = allValues(W, start, k)
  const pool = type === 'minpos' ? vals.filter((n) => n.v > 0) : vals
  const best = type === 'max' ? Math.max(...pool.map((n) => n.v)) : Math.min(...pool.map((n) => n.v))
  const key = (occ) => [...occ].sort().join(' '), na = narrowAns && key(narrowAns)
  const c = pool.filter((n) => n.v === best).sort((a, b) => a.j - b.j || (key(b.occ) === na) - (key(a.occ) === na) || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0) || (key(a.occ) < key(b.occ) ? -1 : 1))
  return { best, occ: c[0].occ, text: c[0].text }
}
// narrow puzzle (as made/verified by make) -> stored, widened data
function toData(p) {
  const W = p.width + 2 * PAD, start = shift(p.start, PAD); let ans = shift(p.solutionSlots, PAD), best = p.best, solution = p.solution
  if (p.goal.type === 'max' || p.goal.type === 'min' || p.goal.type === 'minpos') { const b = wideBest(p.goal.type, W, start, p.goal.moves, ans); best = b.best; ans = b.occ; solution = E.render(W, ans) }
  return { goal: p.goal, width: W, pad: PAD, ...(best !== undefined ? { best } : {}), text: p.startText, solution, start: start.join(' '), answer: [...ans].sort().join(' ') }
}
const unpadded = (p) => { const d = p.pad || 0; return { goal: p.goal, width: p.width - 2 * d, best: p.best, start: shift(p.start.split(' '), -d), solutionSlots: shift(p.answer.split(' '), -d), startText: p.text, solution: p.solution } }
// stored (wide) puzzle check: fix/target keep the narrow uniqueness checks; max/min/minpos: best is the wide optimum
function verifyData(p) {
  const n = unpadded(p), errs = []
  if ((p.pad || 0) !== PAD) errs.push('not widened')
  if (n.start.some((s) => +s.split(':')[1] < 0) || E.render(p.width, p.start.split(' ')) !== p.text) errs.push('wide start text')
  if (p.goal.type === 'fix' || p.goal.type === 'target') return [...errs, ...verify(n)]
  const W = p.width, start = p.start.split(' '), ans = p.answer.split(' '), k = p.goal.moves, v0 = E.value(W, start)
  if (E.render(W, ans) !== p.solution) errs.push('solution text')
  const m = E.moveCount(start, ans); if (!m || m > k) errs.push('answer move count')
  if (E.value(W, ans) !== p.best) errs.push('answer does not reach best')
  if (p.goal.type === 'minpos' && !(p.best > 0)) errs.push('minpos best is not positive')
  if (!(p.goal.type === 'max' ? p.best > v0 : p.best < v0)) errs.push('best does not beat start')
  const b = wideBest(p.goal.type, W, start, k); if (b.best !== p.best) errs.push(`wide best is ${b.best}, stored ${p.best}`)
  return errs
}

// full check of one stored puzzle: answer reaches the goal in exactly k moves, the start text matches,
// the start doesn't already meet the goal, and the answer is the unique solution (or unique best)
function verify(p) {
  const k = p.goal.moves, errs = []
  if (E.render(p.width, p.start) !== p.startText) errs.push('start text')
  if (E.render(p.width, p.solutionSlots) !== p.solution) errs.push('solution text')
  if (E.moveCount(p.start, p.solutionSlots) !== k) errs.push('answer move count')
  if (!E.meets(p.goal, p.width, p.solutionSlots, p.best)) errs.push('answer does not meet goal')
  if (E.meets(p.goal, p.width, p.start, p.best)) errs.push('start already meets goal')
  if (p.goal.type === 'fix') { const s = solveFix(p.width, p.start, k, 5); if (s.length !== 1 || s[0].j !== k) errs.push(`${s.length} distinct fixes`) }
  else {
    const vals = allValues(p.width, p.start, k)
    if (p.goal.type === 'target') { const s = distinct(vals.filter((n) => n.v === p.goal.target)); if (s.length !== 1 || s[0].j !== k) errs.push(`${s.length} target boards`) }
    else {
      const pool = p.goal.type === 'minpos' ? vals.filter((n) => n.v > 0) : vals
      const best = p.goal.type === 'max' ? Math.max(...pool.map((n) => n.v)) : Math.min(...pool.map((n) => n.v))
      if (best !== p.best) errs.push(`best is ${best}, stored ${p.best}`); else if (distinct(pool.filter((n) => n.v === best)).length !== 1) errs.push('several best boards')
    }
  }
  return errs
}

if (arg('selftest')) { selftest(); process.exit(0) }
PUZZLES.forEach((d, i) => { if (d.date !== iso(day(EPOCH) + i)) throw new Error(`PUZZLES[${i}] has date ${d.date}, expected ${iso(day(EPOCH) + i)}`) })
if (arg('widen')) {
  let n = 0
  for (const d of PUZZLES) d.puzzles = d.puzzles.map((p) => { if (p.pad) return p; n++; const w = toData(unpadded(p)); if (w.best !== p.best) console.error(`${d.date} ${p.goal.type}/${p.goal.moves} ${p.text}: best ${p.best} -> ${w.best} (${w.solution})`); return w })
  const cur = fs.readFileSync(HTML, 'utf8'), body = '[\n' + PUZZLES.map((d) => JSON.stringify(d)).join(',\n') + '\n]'
  fs.writeFileSync(HTML, cur.slice(0, cur.indexOf(PB) + PB.length) + body + cur.slice(cur.indexOf(PE)))
  console.error(`widened ${n} puzzles`); process.exit(0)
}
if (arg('verify')) {
  let bad = 0, n = 0
  const starts = new Map()
  for (const d of PUZZLES) d.puzzles.forEach((p, i) => { n++; const e = verifyData(p); if (starts.has(p.text)) e.push(`start ${p.text} already used on ${starts.get(p.text)}`); starts.set(p.text, d.date); if (e.length) { bad++; console.error(`${d.date} #${i + 1}: ${e.join(', ')}`) } })
  const types = {}; for (const d of PUZZLES) for (const p of d.puzzles) { const t = p.goal.type + p.goal.moves; types[t] = (types[t] || 0) + 1 }
  console.error(`verified ${n} puzzles over ${PUZZLES.length} days (${PUZZLES[0]?.date} .. ${PUZZLES.at(-1)?.date}); problems: ${bad}`, types)
  process.exit(bad ? 1 : 0)
}

for (const d of PUZZLES) for (const p of d.puzzles) usedStarts.add(p.text)
const first = arg('shard') ? day(arg('from')) : PUZZLES.length ? day(PUZZLES.at(-1).date) + 1 : day(EPOCH)
const last = arg('to') ? day(arg('to')) : first + Number(arg('days', 30)) - 1
const jobs = Number(arg('jobs', 1))
if (jobs > 1 && !arg('shard')) { // split the range into contiguous chunks, run them in parallel, then append in order
  const { execFileSync, spawn } = await import('child_process'), os = await import('os')
  const per = Math.ceil((last - first + 1) / jobs), runs = []
  for (let a = first; a <= last; a += per) {
    const out = `${os.tmpdir()}/stickle-shard-${iso(a)}.json`
    if (fs.existsSync(out)) { runs.push(Promise.resolve(out)); continue } // finished chunk from an interrupted run
    runs.push(new Promise((res, rej) => spawn(process.execPath, [fileURLToPath(import.meta.url), '--shard', `--from=${iso(a)}`, `--to=${iso(Math.min(last, a + per - 1))}`, `--out=${out}`], { stdio: 'inherit' })
      .on('exit', (c) => (c ? rej(new Error('shard failed ' + iso(a))) : res(out)))))
  }
  const files = await Promise.all(runs)
  // chunks can't see each other's start boards: a day that repeats an earlier start is regenerated here
  for (const f of files) for (const d of JSON.parse(fs.readFileSync(f))) {
    if (d.puzzles.some((p) => usedStarts.has(p.text))) { console.error(`  ${d.date} repeats an earlier start; regenerating`); PUZZLES.push(genDay(day(d.date))) }
    else { d.puzzles.forEach((p) => usedStarts.add(p.text)); PUZZLES.push(d) }
  }
  for (const f of files) fs.unlinkSync(f)
}
const shardDays = []
const write = () => {
  if (arg('shard')) return fs.writeFileSync(arg('out'), JSON.stringify(shardDays))
  const body = '[\n' + PUZZLES.map((d) => JSON.stringify(d)).join(',\n') + '\n]'
  const cur = fs.readFileSync(HTML, 'utf8')
  fs.writeFileSync(HTML, cur.slice(0, cur.indexOf(PB) + PB.length) + body + cur.slice(cur.indexOf(PE)))
}
// 3 verified puzzles for day n, avoiding every start board used so far. The per-date seed can land on the same
// candidates as an earlier day; if the day can't be made, it is retried with a salted seed.
function genDay(n) {
  for (let salt = 0; ; salt++) {
    try { return genDayWith(n, salt) } catch (e) { if (salt === 5) throw e; console.error(`  ${iso(n)}: ${e.message}; retrying with another seed`) }
  }
}
function genDayWith(n, salt) {
  const date = iso(n); seed = Number((BigInt(n) * 2654435761n + BigInt(salt) * 2654435769n) % 2147483648n) || 1
  const t0 = Date.now()
  const puzzles = PLAN[((n % 7) + 7) % 7].map(([t, k, sh], i) => {
    // unique 2-move equation fixes are rare on the free lattice: fall back to 1 move on a longer equation
    // (and if even that fails, keep trying wider shapes; the seed moves on with every attempt)
    const tries = [[t, k, sh], [t, 1, t === 'fix' ? 'DD+D=DD|DD-D=DD' : sh], [t, 1, t === 'fix' ? 'DD+DD=DD|DD-DD=DD|D+DD=DD|DD-D=D' : sh], ...(t === 'fix' ? [] : [['fix', 1, 'DD+D=DD|DD-D=DD']])]
    for (const [j, [tt, kk, ss]] of tries.entries()) {
      try { return make(tt, kk, ss) } catch (e) { if (j === tries.length - 1) throw e; console.error(`  ${date} #${i + 1}: ${e.message}; falling back`) }
    }
  })
  puzzles.forEach((p) => { const e = verify(p); if (e.length) throw new Error(`${date}: ${e.join(', ')} ${JSON.stringify(p)}`); usedStarts.add(p.startText) })
  const entry = { date, puzzles: puzzles.map(toData) }
  console.error(date, puzzles.map((p) => `${p.goal.type}/${p.goal.moves}${p.goal.target !== undefined ? '=' + p.goal.target : ''} ${p.startText} -> ${p.solution}`).join(' | '), `(${Date.now() - t0}ms)`)
  return entry
}
for (let n = first; n <= last && !(jobs > 1 && !arg('shard')); n++) {
  const entry = genDay(n)
  if (arg('shard')) shardDays.push(entry); else PUZZLES.push(entry)
  if ((n - first) % 10 === 9) write() // save progress as we go
}
write()
if (!arg('shard')) console.error(`index.html now has ${PUZZLES.length} days (${PUZZLES[0].date} .. ${PUZZLES.at(-1).date})`)
