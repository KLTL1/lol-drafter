# LoL Draft Assistant

An interactive League of Legends pick/ban draft assistant for competitive 5v5 teams. Enter bans and picks as the draft happens and get scored champion recommendations at every step.

**[Use it here](https://kltl1.github.io/lol-drafter/)** — or just open `index.html` in a browser. No build, no server.

## Features

- Full tournament draft order: ban phase 1 → pick phase 1 → ban phase 2 → pick phase 2, for both teams
- Blue/red side selection, with first-pick order decoupled (2026 "First Selection" pro rules)
- Pro-style recommendation engine: pro play presence and win rate weighted first, solo queue stats second
- Lane matchups and counterpick timing (safe blinds early, counterpicks last)
- Team comp analysis: AD/AP damage profile, frontline, CC, engage, early/late game lean, with warnings
- Synergy detection (bot lane duos, wombo combos, jungle pairings)
- Ban suggestions that account for pro priority, flex threats, and counters to your locked picks
- Fearless draft mode for series play — exclude champions used in earlier games
- Click any earlier slot to revise it; undo and reset

## Data

`data.js` is a snapshot of **patch 26.12** (June 2026): OP.GG Emerald+ solo queue stats per role, gol.gg 2026 pro season pick/ban data, and curated matchup/synergy directions. Champion icons load from Riot's Data Dragon at the current live version automatically. Refresh the snapshot when a new patch shifts the meta.

Not affiliated with Riot Games.
