# Stickle

A daily matchstick puzzle in a single web page, in the spirit of the original Wordle: no server, no build step, no framework, no accounts.
Everything (the game, the puzzle list and the answers) lives in [`index.html`](index.html).

**Play:** https://geekahedron.github.io/stickle/

## How to play

Each day has three puzzles. The board shows digits and signs made of matches, and each puzzle has a goal:

| Goal | Example |
|---|---|
| **Fix** the equation | `8-11=4` → move 1 match → `8-4=4` |
| Make the **largest** number | `117` → move 1 match → `711` |
| Make the **smallest** number | `394` → move 1 match → `294` |
| Hit a **target** | `37-1`, make it 32 → move 1 match → `31+1` |

Drag a match to an empty spot, or tap a match and then tap where it should go. Undo, Reset and Give up are under the board.
The board has two spare columns on each side, so you can add a digit or put a `-` in front of a number.

**Submit:** once the board reads right for the goal (a true equation, the target value, or any valid number for largest/smallest) using 1 up to the allowed number of moves, the Submit button lights up.
Each puzzle gets one submit, saved in your browser, and the rating stays after a reload:
- **Fix** and **target** puzzles: any correct answer is **Perfect** 🔥.
- **Largest/smallest** puzzles are scored against the best value reachable on the whole board, e.g. *Your 711 vs best 7111*. Progress = (your value − start) ÷ (best − start): **Perfect** 🔥 = the best, **Great** ⭐ ≥ 75%, **Good** 👍 ≥ 40%, **Valid** ✅ otherwise.

When all three are done you get share text like:

```
Stickle #18 — 2/3 perfect
🔥⭐🔥 Perfect · Great · Perfect
https://geekahedron.github.io/stickle/?p=18
```

Progress is saved in your browser (`localStorage`), so a reload doesn't lose anything. Past days are in the archive (`#/archive`).

## How the puzzles work

### The board

Matches sit on a continuous lattice that's `width` columns wide and two rows tall. Every match is the same length.
A match can go in any slot, including the gaps between characters:

```
 h0:c        horizontal bars over column c: top / middle / bottom
 h1:c
 h2:c
 lo:c        lower half-height bar (the second bar of "=")
 cv:c        short centre upright (the vertical of "+")
 v0:x v1:x   upper / lower vertical on boundary x (shared by neighbouring columns)
```

The engine (`Engine` in `index.html`) reads connected groups left to right:
- A lone full boundary is a `1`.
- One column is `+`, `=` or `-`, or a seven-segment digit.
- Anything else makes the board unreadable.
- Neighbouring digits form one number.
- A `-` at the start, right after `=` or right after `+` is a negative sign. `--` and `-0` aren't allowed.
- There's no × or ÷.

### The puzzle list

`PUZZLES` in `index.html` has one entry per day, starting at `EPOCH` (2026-10-01 is #1). Today's puzzle is looked up by the player's **local** date, so a new set unlocks at local midnight. Future days can't be opened.

```js
{"date":"2026-10-01","puzzles":[
  {"goal":{"type":"fix","moves":1},"width":11,"text":"8-11=4","solution":"8-4=4",
   "start":"h0:1 v0:2 …","answer":"h0:1 h1:1 …"}, …]}
```

`start` and `answer` are the occupied slots, and `pad` is the number of spare columns added on each side of the starting text. For `max` and `min` puzzles, `best` is the best value reachable anywhere on the padded board (extra digits and leading minus signs included) and `answer` is a board that reaches it; Give up shows that board. The answers are in the page source, just as Wordle's were.

### Generating more days

```sh
node scripts/generate.mjs --days=30        # add 30 days after the last one
node scripts/generate.mjs --to=2028-01-31  # add days up to a date
node scripts/generate.mjs --verify         # re-check every puzzle in index.html
node scripts/check-best.mjs                # slow, engine-only brute force of every stored best (~5 min)
```

`generate.mjs` uses plain Node with no dependencies. It reads the engine straight out of `index.html`, so the game and the generator always agree, and it rewrites the `PUZZLES` array in place.
- **Daily mix:** each day follows a weekly plan of three goals that get harder (for example 1-move fix, then max, then 2-move fix).
- **Same output every run:** each date gets its own fixed random seed, so a given date always produces the same puzzles.
- **No repeats:** a starting board is never reused.
- **Checked by brute force:** every puzzle is verified by trying every board reachable within its move limit.
  - Fix and target puzzles must have exactly one solution, and none that uses fewer moves.
  - Max and min puzzles must have exactly one board that reaches the best value, and that value must beat the starting board.
- **Scored on the wider board:** each puzzle is then padded with two empty columns per side, and for max/min the stored `best` is found by searching every board within the move limit on the padded board.

## Testing

```sh
npm i -D playwright && npx playwright install chromium
BASE=http://localhost:8080/ node scripts/test.mjs
```

The test runs on a phone-sized touch screen. It:
- solves and submits today's puzzles by dragging and by tap-then-tap, and checks the Submit button and ratings;
- checks undo, the share text, that progress survives a reload, the archive, give up, `?p=N` links, locked future days and lookup by local date.

## Hosting

Any static host works. This repo is served by GitHub Pages from the root of `main`.
