#!/usr/bin/env node
// Independent brute-force check of the stored best answers (slow on purpose: it only uses the game engine read
// from index.html, not the generator's fast evaluator). For every max/min/minpos puzzle it tries every board reachable
// with 1..k moves on the full (widened) lattice and checks the stored `best` is the extreme value and that the
// stored answer reaches it. Fix/target puzzles: checks the answer reads right within k moves.
//   node scripts/check-best.mjs            all days        node scripts/check-best.mjs --to=2026-11-30
import fs from 'fs'
import { fileURLToPath } from 'url'
const html = fs.readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8')
const E = new Function(html.slice(html.indexOf('// /*ENGINE-BEGIN*/'), html.indexOf('// /*ENGINE-END*/')) + '; return Engine')()
const PUZZLES = JSON.parse(html.slice(html.indexOf('/*PUZZLES-BEGIN*/') + 17, html.indexOf('/*PUZZLES-END*/')))
const to = (process.argv.find((a) => a.startsWith('--to=')) || '').slice(5) || '9999'
function* combos(a, k, s = 0, acc = []) { if (acc.length === k) { yield acc; return } for (let i = s; i < a.length; i++) { acc.push(a[i]); yield* combos(a, k, i + 1, acc); acc.pop() } }
let bad = 0, n = 0
for (const d of PUZZLES) {
  if (d.date > to) break
  d.puzzles.forEach((p, i) => {
    n++; const W = p.width, start = p.start.split(' '), ans = p.answer.split(' '), k = p.goal.moves, errs = []
    const m = E.moveCount(start, ans); if (!m || m > k) errs.push('answer moves')
    if (p.goal.type === 'fix' && !E.isTrueEquation(W, ans)) errs.push('answer not true')
    if (p.goal.type === 'target' && E.value(W, ans) !== p.goal.target) errs.push('answer misses target')
    if (p.goal.type === 'max' || p.goal.type === 'min' || p.goal.type === 'minpos') {
      const empty = E.slotsOf(W).filter((s) => !start.includes(s))
      let best = p.goal.type === 'max' ? -Infinity : Infinity
      for (let j = 1; j <= k; j++) for (const rem of combos(start, j)) { const keep = start.filter((x) => !rem.includes(x)); for (const add of combos(empty, j)) { const v = E.value(W, [...keep, ...add]); if (v === null) continue; if (p.goal.type === 'minpos' && !(v > 0)) continue; if (p.goal.type === 'max' ? v > best : v < best) best = v } }
      if (best !== p.best) errs.push(`brute-force best ${best}, stored ${p.best}`)
      if (E.value(W, ans) !== p.best) errs.push('answer does not reach best')
      if (p.goal.type === 'minpos' && !(p.best > 0)) errs.push('minpos best is not positive')
    }
    if (errs.length) { bad++; console.error(`${d.date} #${i + 1} ${p.text}: ${errs.join(', ')}`) }
  })
}
console.error(`checked ${n} puzzles; problems: ${bad}`); process.exit(bad ? 1 : 0)
