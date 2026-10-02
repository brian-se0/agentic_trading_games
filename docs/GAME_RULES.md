# Implemented Game Rules and Policies

Each session stores its rule and bot identifiers. Unknown saved rule identifiers
are never deserialized by an engine; unfinished tables are quarantined and can
only be voided.

## Common modes and integrity policy

- `random`: one human per room with constrained-random server agents.
- `strategy`: one human per room with the documented game-specific agents.
- `live`: humans are CSPRNG-shuffled into bounded tables after lobby lock.

Non-trading human turns use a configurable 10-120 second deadline (30 seconds
by default). Timeout actions are deterministic and auditable. Any timeout or bot
takeover permanently makes that student's outcome ineligible. All live
peer-dependent outcomes are diagnostic rather than competitive because no game
engine can prevent off-platform collusion. Authenticated student submissions
remain available for evaluation, but software does not attest unaided human
authorship.

Voiding discards or refunds the incomplete round/hand and never converts it into
a winner. Ending early preserves finished rounds but voids the active one,
except trading, whose healthy early close performs the documented settlement.

## Iterated Rock Paper Scissors

- Two seats with simultaneous hidden submissions.
- Configurable 10-100 rounds; default 30.
- Win = 1 point, loss/draw = 0.
- A timeout submits `rock` and records system provenance.
- Random policy is uniform. Strategy policy uses Laplace-smoothed empirical
  frequencies, mostly best-responds, and retains exploration.
- Aborting discards an incomplete simultaneous round.

## Classroom Liar's Dice

- Two to six seats; five recommended. Each seat receives five private d6.
- Ones are wild for announced faces 2-6; bidding ones is unsupported.
- Bids increase quantity, or keep quantity and increase face.
- Challenge reveals all dice. A true bid gives bidder +1/challenger -1; a false
  bid reverses that result. Nobody is eliminated.
- Default eight rounds. The challenger starts the next round.
- Timeout challenges when legal, otherwise makes the lowest legal bid.
- Strategy agents combine exact binomial bid probability, calibrated challenge
  thresholds, and stochastic plausible/bluff bids.
- Aborting discards the incomplete round without scoring it.

## Blackjack

- Six-deck shoe; reshuffle below 52 remaining cards.
- Dealer stands on hard and soft 17. Blackjack pays 3:2; ordinary wins 1:1.
- Fixed wager 10; each seat starts with 200. Default five rounds.
- Hit, stand, double, and one split are supported. Split aces receive one card.
  Insurance, surrender, and side bets are absent.
- A split hand that reaches 21 automatically stands, so every projected state
  with no legal action can advance.
- Timeout stands when legal, otherwise takes the deterministic safe legal move.
- Strategy agents use the documented basic-strategy approximation.
- Aborting restores every bankroll to its start-of-round value, including
  split/double wagers; restart never draws cards or advances RNG implicitly.

## Fixed-Limit Leduc Poker

- Two to six seats; five recommended. The generalized deck has two copies of
  each rank and enough ranks for all private cards plus one public card.
- Each seat antes 1 and starts with 40 chips. Default five hands.
- Round-one raises are 2; round-two raises are 4; at most two raises per round.
- Legal actions are check/call, fold when facing a bet, and raise when cap and
  stack allow. Pair beats non-pair; otherwise higher private rank wins; ties
  split the pot.
- A fold-only finish reveals no folded private cards. Timeout checks if possible
  and otherwise folds; it never awards a pot to a player with a pending call.
- Strategy agents use the private card's rank, whether it pairs with the public
  card, whether a call is required, and available actions. They follow the
  resulting recommendation on 80% of turns and choose a random legal action
  otherwise.
  This heuristic does not calculate equity, pot odds, or positional advantage.
- Aborting restores start-of-hand stacks, clears the pot, and records no winner
  or private reveal.

## Server-Mediated Trading Market

- Live tables contain at most fourteen students plus exactly one server market
  maker; random/strategy rooms contain one human and server agents.
- One asset has hidden terminal value 80-120. Each trader starts with cash 1,000,
  zero inventory, a private noisy signal, and position bounds [-10, 10].
- Limit prices are exact integer ticks from 1-250; quantities are integers 1-5.
  Invalid values are rejected, never rounded or clamped.
- Orders use price-time priority and resting-price execution. Market orders are
  immediate-or-cancel. Reservations enforce cash and gross position capacity.
- Human orders never execute against other human orders. A trade requires a
  server-owned side: student flow can trade with the market maker, while direct
  peer wealth transfer and multi-seat score laundering are excluded by design.
- A participant account remains student-owned while a bot temporarily controls
  its seat. Open orders are cancelled at every takeover/restore boundary, so
  controller changes cannot create server-liquidity privileges or stale orders.
- Default duration is 90 seconds (configurable 30-300). A serialized monotonic
  remaining-time clock survives pause/restart and closes inside the room queue.
- The scheduler advances at most one server-controlled trading order per table
  pass, rotating deterministically among eligible bots. Table count and
  duration therefore bound automated event/storage growth.
- Each authenticated student can persist at most 300 action attempts in one
  activity; accepted no-fill immediate-or-cancel orders and recorded rule
  rejections both consume that durable allowance.
- At a healthy close, remaining inventory settles at terminal value and
  diagnostic P/L is ending cash + terminal value × inventory - initial cash.
  Trading P/L, fills, and markouts are never authoritative grading outcomes.
- Voiding clears orders and leaves `scored=false`, `pnl=null`, and no terminal
  value/result settlement.
