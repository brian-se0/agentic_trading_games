import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditRandom } from '../src/random.js';
import { BlackjackGame, canonicalizeAction, LeducGame, LiarsDiceGame, RpsGame, TradingGame } from '../src/games.js';

const human = (id) => ({ id, name: id.toUpperCase(), isBot: false, botKind: null });
const bot = (id, botKind = 'strategy') => ({ id, name: id.toUpperCase(), isBot: true, botKind });
const rng = (byte) => new AuditRandom(byte.repeat(64));

function assertTradingInvariants(game) {
  for (const player of game.players) {
    const resources = game.availableResources(player.id);
    assert.ok(resources.reservedCash >= 0 && resources.reservedCash <= game.state.cash[player.id]);
    assert.ok(game.state.inventory[player.id] + resources.reservedBuyQuantity <= 10);
    assert.ok(game.state.inventory[player.id] - resources.reservedSellQuantity >= -10);
  }
  assert.ok(game.state.orders.every((order) => order.orderType === 'limit' && Number.isFinite(order.price) &&
    Number.isInteger(order.remaining) && order.remaining > 0));
  assert.ok(Math.abs(Object.values(game.state.cash).reduce((sum, amount) => sum + amount, 0) - game.players.length * 1000) < 1e-9);
  assert.equal(Object.values(game.state.inventory).reduce((sum, amount) => sum + amount, 0), 0);
}

test('RPS resolves simultaneous moves and completes the configured match', () => {
  const game = new RpsGame({ players: [human('a'), human('b')], config: { rounds: 10 }, rng: rng('1') });
  for (let round = 0; round < 10; round += 1) {
    game.act('a', { type: 'play', choice: 'rock' });
    assert.equal(game.view('b').history.length, round);
    game.act('b', { type: 'play', choice: 'scissors' });
  }
  assert.equal(game.state.scores.a, 10);
  assert.equal(game.state.history.length, 10);
  assert.equal(game.state.status, 'completed');
  assert.deepEqual(game.benchmark('a').nashPolicy, { rock: 1 / 3, paper: 1 / 3, scissors: 1 / 3 });
});

test("Liar's Dice hides live dice, resolves challenges, and forces a challenge at the bid ceiling", () => {
  const players = [human('a'), bot('b', 'random'), human('c')];
  const game = new LiarsDiceGame({ players, config: { rounds: 3 }, rng: rng('2') });
  const aView = game.view('a');
  assert.equal(aView.yourDice.length, 5);
  assert.equal('dice' in aView, false);
  game.act('a', { type: 'bid', quantity: 1, face: 2 });
  const resolved = game.act('b', { type: 'challenge' });
  assert.equal(resolved.type, 'challenge_resolved');
  assert.equal(Object.keys(resolved.resolution.revealedDice).length, 3);

  game.state.currentIndex = 1;
  game.state.bid = { quantity: 15, face: 6 };
  assert.deepEqual(game.legalActions('b'), [{ type: 'challenge' }]);
  assert.deepEqual(game.botAction('b'), { type: 'challenge' });
});

test('Blackjack bots finish a round and the dealer hole card remains hidden during play', () => {
  const game = new BlackjackGame({ players: [bot('a', 'strategy'), bot('b', 'random')], config: { rounds: 1 }, rng: rng('3') });
  if (!game.isComplete()) {
    const view = game.view('a');
    assert.deepEqual(view.dealer[1], { hidden: true });
    assert.deepEqual(Object.keys(view.hands), ['a']);
  }
  let actions = 0;
  while (!game.isComplete() && actions < 100) {
    const id = game.pendingBot();
    assert.ok(id, 'a bot should have the turn');
    game.act(id, game.botAction(id));
    actions += 1;
  }
  assert.equal(game.state.status, 'completed');
  assert.equal(game.state.history.length, 1);
  assert.ok(actions < 100);
});

test('dealer blackjack only pushes against a natural two-card blackjack', () => {
  const game = new BlackjackGame({ players: [human('a'), human('b'), human('c')], config: { rounds: 1 }, rng: rng('3') });
  game.state.dealer = [{ rank: 'A', suit: 'S' }, { rank: 'K', suit: 'H' }];
  game.state.bankrolls = { a: 190, b: 190, c: 190 };
  game.state.hands = {
    a: [{ cards: [{ rank: '7', suit: 'S' }, { rank: '7', suit: 'H' }, { rank: '7', suit: 'D' }], bet: 10, fromSplit: false }],
    b: [{ cards: [{ rank: 'A', suit: 'H' }, { rank: 'K', suit: 'D' }], bet: 10, fromSplit: false }],
    c: [{ cards: [{ rank: 'A', suit: 'D' }, { rank: 'K', suit: 'C' }], bet: 10, fromSplit: true }]
  };

  game.resolveDealer({ continueMatch: false });

  assert.deepEqual(game.state.history[0].outcomes.a.map((hand) => hand.result), ['loss']);
  assert.deepEqual(game.state.history[0].outcomes.b.map((hand) => hand.result), ['push']);
  assert.deepEqual(game.state.history[0].outcomes.c.map((hand) => hand.result), ['loss']);
  assert.deepEqual(game.state.bankrolls, { a: 190, b: 200, c: 190 });
});

test('forcing Blackjack completion refunds and discards only the active round', () => {
  const game = new BlackjackGame({ players: [human('a'), human('b')], config: { rounds: 3 }, rng: rng('1') });
  assert.equal(game.state.round, 1);
  const roundStart = structuredClone(game.state.roundStartBankrolls);
  game.forceComplete();
  assert.equal(game.state.status, 'completed');
  assert.equal(game.state.phase, 'aborted');
  assert.equal(game.state.round, 1);
  assert.equal(game.state.history.length, 0);
  assert.deepEqual(game.state.bankrolls, roundStart);
  assert.deepEqual(game.state.dealer, []);
  assert.deepEqual(game.state.hands, {});
  assert.deepEqual(game.state.termination, { reason: 'instructor_end', outcome: 'void', discardedRound: 1 });
  const settled = structuredClone(game.serialize());
  game.forceComplete();
  assert.deepEqual(game.serialize(), settled);
});

test('Blackjack void refunds initial, split, and double wagers from the persisted round ledger', () => {
  const game = new BlackjackGame({ players: [human('a'), human('b')], config: { rounds: 3 }, rng: rng('0') });
  game.state.status = 'running';
  game.state.round = 1;
  game.state.phase = 'players';
  game.state.currentIndex = 0;
  game.state.currentHand = 0;
  game.state.roundStartBankrolls = { a: 200, b: 200 };
  game.state.bankrolls = { a: 190, b: 190 };
  game.state.hands = {
    a: [{ cards: [{ rank: '8', suit: 'S' }, { rank: '8', suit: 'H' }], bet: 10, stood: false, doubled: false, fromSplit: false }],
    b: [{ cards: [{ rank: '6', suit: 'S' }, { rank: '7', suit: 'H' }], bet: 10, stood: false, doubled: false, fromSplit: false }]
  };
  game.state.dealer = [{ rank: '9', suit: 'S' }, { rank: '7', suit: 'D' }];
  game.state.shoe = [
    ...Array.from({ length: 52 }, () => ({ rank: '2', suit: 'C' })),
    { rank: '4', suit: 'D' }, { rank: '3', suit: 'D' }, { rank: '2', suit: 'D' }
  ];

  game.act('a', { type: 'split' });
  game.act('a', { type: 'double' });
  assert.equal(game.state.bankrolls.a, 170);
  assert.deepEqual(game.state.hands.a.map((hand) => hand.bet), [20, 10]);

  game.abortCurrent('unhealthy_table');
  assert.deepEqual(game.state.bankrolls, { a: 200, b: 200 });
  assert.deepEqual(game.state.hands, {});
  assert.deepEqual(game.state.dealer, []);
  assert.equal(game.state.history.length, 0);
  assert.equal(game.state.termination.reason, 'unhealthy_table');
});

test('generalized fixed-limit Leduc completes and projects only the requesting private card', () => {
  const players = [bot('a'), bot('b', 'random'), bot('c')];
  const game = new LeducGame({ players, config: { rounds: 2 }, rng: rng('4') });
  const view = game.view('a');
  assert.ok(view.yourPrivateCard);
  assert.equal('privateCards' in view, false);
  let actions = 0;
  while (!game.isComplete() && actions < 300) {
    const id = game.pendingBot();
    assert.ok(id);
    game.act(id, game.botAction(id));
    actions += 1;
  }
  assert.equal(game.state.status, 'completed');
  assert.equal(game.state.history.length, 2);
  assert.ok(game.view('a').lastShowdown);
  assert.ok(actions < 300);
});

test('forcing Leduc completion settles only the active hand and is idempotent', () => {
  const game = new LeducGame({ players: [human('a'), human('b'), human('c')], config: { rounds: 3 }, rng: rng('4') });
  const dealerIndex = game.state.dealerIndex;
  const privateCards = structuredClone(game.state.privateCards);
  const startStacks = structuredClone(game.state.handStartStacks);
  game.act(game.currentPlayerId(), { type: 'raise' });
  assert.ok(game.state.currentBet > game.state.contribution[game.currentPlayerId()]);
  game.forceComplete();
  assert.equal(game.state.status, 'completed');
  assert.equal(game.state.hand, 1);
  assert.equal(game.state.history.length, 1);
  assert.equal(game.state.lastShowdown.reason, 'instructor_end');
  assert.equal(game.state.lastShowdown.outcome, 'void');
  assert.deepEqual(game.state.lastShowdown.revealed, {});
  assert.deepEqual(game.state.lastShowdown.winners, []);
  assert.equal(game.state.pot, 0);
  assert.deepEqual(game.state.stacks, startStacks);
  assert.equal(game.state.dealerIndex, dealerIndex);
  assert.deepEqual(game.state.privateCards, privateCards);
  const settled = structuredClone(game.serialize());
  game.forceComplete();
  assert.deepEqual(game.serialize(), settled);
});

test('RPS and Liar\'s Dice termination preserves completed rounds and discards partial rounds', () => {
  const rps = new RpsGame({ players: [human('a'), human('b')], config: { rounds: 10 }, rng: rng('a') });
  rps.act('a', { type: 'play', choice: 'rock' });
  rps.act('b', { type: 'play', choice: 'scissors' });
  rps.act('a', { type: 'play', choice: 'paper' });
  const rpsHistory = structuredClone(rps.state.history);
  const rpsScores = structuredClone(rps.state.scores);
  rps.abortCurrent('session_voided');
  assert.deepEqual(rps.state.history, rpsHistory);
  assert.deepEqual(rps.state.scores, rpsScores);
  assert.deepEqual(rps.state.submissions, {});
  assert.deepEqual(rps.state.termination, { reason: 'session_voided', outcome: 'void', discardedRound: 2 });

  const dice = new LiarsDiceGame({ players: [human('a'), human('b')], config: { rounds: 3 }, rng: rng('b') });
  let current = dice.players[dice.state.currentIndex].id;
  dice.act(current, { type: 'bid', quantity: 1, face: 2 });
  current = dice.players[dice.state.currentIndex].id;
  dice.act(current, { type: 'challenge' });
  current = dice.players[dice.state.currentIndex].id;
  dice.act(current, { type: 'bid', quantity: 1, face: 2 });
  const diceHistory = structuredClone(dice.state.history);
  const diceScores = structuredClone(dice.state.scores);
  dice.forceComplete();
  assert.deepEqual(dice.state.history, diceHistory);
  assert.deepEqual(dice.state.scores, diceScores);
  assert.equal(dice.state.bid, null);
  assert.equal(dice.state.lastBidder, null);
  assert.ok(Object.values(dice.state.dice).every((hand) => hand.length === 0));
  assert.deepEqual(dice.state.termination, { reason: 'instructor_end', outcome: 'void', discardedRound: 2 });
});

test('Leduc outcomes retain the resolving hand and pot, and benchmarks stay legal', () => {
  const game = new LeducGame({ players: [human('a'), human('b')], config: { rounds: 2 }, rng: rng('d') });
  const raiser = game.currentPlayerId();
  game.act(raiser, { type: 'raise' });
  const folder = game.currentPlayerId();
  const result = game.act(folder, { type: 'fold' });
  assert.equal(result.hand, 1);
  assert.equal(result.pot, 4);
  assert.equal(result.resolution.pot, 4);
  assert.deepEqual(result.resolution.revealed, {});
  assert.deepEqual(game.view(folder).lastShowdown.revealed, {});
  assert.equal(game.state.hand, 2);
  assert.equal(game.state.pot, 2);

  game.state.pending = [raiser];
  game.state.currentIndex = game.players.findIndex((player) => player.id === raiser);
  game.state.stacks[raiser] = 0;
  game.state.currentBet = 2;
  game.state.contribution[raiser] = 0;
  game.state.privateCards[raiser] = { rank: 3, suit: 0 };
  assert.deepEqual(game.legalActions(raiser), [{ type: 'fold' }]);
  assert.equal(game.benchmark(raiser).recommendedAction, 'fold');
});

test('continuous double auction uses price-time matching and prevents self-trades', () => {
  const game = new TradingGame({ players: [human('a'), bot('b')], config: { duration: 90 }, rng: rng('5') });
  game.act('a', { type: 'limit', side: 'sell', price: 105, quantity: 2 });
  game.act('b', { type: 'limit', side: 'buy', price: 106, quantity: 1 });
  assert.equal(game.state.trades.length, 1);
  assert.partialDeepStrictEqual(game.state.trades[0], { price: 105, quantity: 1, buyer: 'b', seller: 'a' });
  assert.equal(game.state.inventory.a, -1);
  assert.equal(game.state.inventory.b, 1);

  const self = new TradingGame({ players: [human('a'), human('b')], config: { duration: 90 }, rng: rng('6') });
  self.act('a', { type: 'limit', side: 'buy', price: 100, quantity: 1 });
  self.act('a', { type: 'limit', side: 'sell', price: 90, quantity: 1 });
  assert.equal(self.state.trades.length, 0);
  assert.equal(self.state.orders.length, 2);
  self.forceComplete();
  assert.equal(self.view('a').terminalValue, self.state.fundamental);
  assert.equal(self.view('a').legalActions.length, 0);
});

test('trading book and best quotes show only executable counterparties', () => {
  const game = new TradingGame({
    players: [human('a'), human('b'), bot('maker', 'market_maker')], config: { duration: 90 }, rng: rng('5')
  });
  game.act('a', { type: 'limit', side: 'sell', price: 90, quantity: 1 });
  game.act('maker', { type: 'limit', side: 'sell', price: 100, quantity: 1 });

  assert.deepEqual(game.view('b').asks, [{ price: 100, remaining: 1 }]);
  assert.equal(game.decisionContext('b').bestAsk, 100);
  assert.deepEqual(game.view('maker').asks, [{ price: 90, remaining: 1 }]);
  assert.equal(game.decisionContext('maker').bestAsk, 90);
  assert.deepEqual(game.view('a').yourOrders.map((order) => order.price), [90]);

  game.act('b', { type: 'market', side: 'buy', quantity: 1 });
  assert.deepEqual(game.state.trades.map((trade) => [trade.price, trade.seller]), [[100, 'maker']]);
  assert.deepEqual(game.view('b').asks, []);
  assert.equal(game.decisionContext('b').bestAsk, null);

  const buySide = new TradingGame({
    players: [human('a'), human('b'), bot('maker', 'market_maker')], config: { duration: 90 }, rng: rng('6')
  });
  buySide.act('a', { type: 'limit', side: 'buy', price: 110, quantity: 1 });
  buySide.act('maker', { type: 'limit', side: 'buy', price: 100, quantity: 1 });
  assert.deepEqual(buySide.view('b').bids, [{ price: 100, remaining: 1 }]);
  assert.equal(buySide.decisionContext('b').bestBid, 100);
  buySide.act('b', { type: 'market', side: 'sell', quantity: 1 });
  assert.deepEqual(buySide.state.trades.map((trade) => [trade.price, trade.buyer]), [[100, 'maker']]);
});

test('completed trading projections freeze the countdown at zero', () => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const game = new TradingGame({ players: [human('a'), human('b')], config: { duration: 90 }, rng: rng('e') });
    game.forceComplete();
    const completedView = structuredClone(game.view('a'));
    const completedContext = structuredClone(game.decisionContext('a'));
    assert.equal(completedView.secondsRemaining, 0);
    assert.equal(completedContext.secondsRemaining, 0);

    now += 60_000;
    assert.deepEqual(game.view('a'), completedView);
    assert.deepEqual(game.decisionContext('a'), completedContext);
  } finally {
    Date.now = realNow;
  }
});

test('trading collateralizes every resting order and releases holds on cancellation', () => {
  const game = new TradingGame({ players: [human('a'), human('b')], config: { duration: 90 }, rng: rng('a') });
  const first = game.act('a', { type: 'limit', side: 'buy', price: 250, quantity: 4 });
  assert.equal(game.availableResources('a').reservedCash, 1000);
  assert.throws(() => game.act('a', { type: 'limit', side: 'buy', price: 1, quantity: 1 }), /available cash/);
  game.act('a', { type: 'cancel', orderId: first.order.id });
  assert.equal(game.availableResources('a').reservedCash, 0);

  game.act('a', { type: 'limit', side: 'buy', price: 1, quantity: 5 });
  game.act('a', { type: 'limit', side: 'buy', price: 1, quantity: 5 });
  assert.throws(() => game.act('a', { type: 'limit', side: 'buy', price: 1, quantity: 1 }), /inventory capacity/);
  game.act('b', { type: 'limit', side: 'sell', price: 200, quantity: 5 });
  game.act('b', { type: 'limit', side: 'sell', price: 201, quantity: 5 });
  assert.throws(() => game.act('b', { type: 'limit', side: 'sell', price: 202, quantity: 1 }), /inventory capacity/);
  assertTradingInvariants(game);
});

test('market orders fill the maximum affordable quantity and cancel the remainder', () => {
  const game = new TradingGame({ players: [human('a'), bot('b')], config: { duration: 90 }, rng: rng('b') });
  game.state.cash.a = 150;
  game.state.cash.b = 1850;
  game.act('b', { type: 'limit', side: 'sell', price: 100, quantity: 2 });
  const result = game.act('a', { type: 'market', side: 'buy', quantity: 2 });
  assert.equal(result.filledQuantity, 1);
  assert.equal(result.cancelledQuantity, 1);
  assert.equal(game.state.trades.length, 1);
  assert.equal(game.state.orders[0].remaining, 1);
  assert.equal(game.state.cash.a, 50);
  assert.equal(game.state.inventory.a, 1);
  assertTradingInvariants(game);
});

test('trading uses monotonic order ids for equal-price time priority', () => {
  const game = new TradingGame({ players: [bot('a'), bot('b'), human('c')], config: { duration: 90 }, rng: rng('c') });
  game.act('a', { type: 'limit', side: 'sell', price: 100, quantity: 1 });
  game.act('b', { type: 'limit', side: 'sell', price: 100, quantity: 1 });
  game.state.orders.forEach((order) => { order.createdAt = 1; });
  game.act('c', { type: 'market', side: 'buy', quantity: 2 });
  assert.deepEqual(game.state.trades.map((trade) => trade.seller), ['a', 'b']);
  assertTradingInvariants(game);
});

test('canonical action schemas reject coercion, extra fields, and out-of-range values', () => {
  assert.deepEqual(canonicalizeAction('rps', { type: 'play', choice: 'rock' }), { type: 'play', choice: 'rock' });
  assert.deepEqual(canonicalizeAction('liars_dice', { type: 'bid', quantity: 2, face: 6 }),
    { type: 'bid', quantity: 2, face: 6 });
  assert.deepEqual(canonicalizeAction('blackjack', { type: 'stand' }), { type: 'stand' });
  assert.deepEqual(canonicalizeAction('poker', { type: 'fold' }), { type: 'fold' });
  assert.deepEqual(canonicalizeAction('trading', { type: 'limit', side: 'buy', price: 100, quantity: 2 }),
    { type: 'limit', side: 'buy', price: 100, quantity: 2 });
  assert.deepEqual(canonicalizeAction('trading', { type: 'cancel', orderId: 7 }), { type: 'cancel', orderId: 7 });

  const invalid = [
    ['rps', { type: 'play', choice: 'rock', padding: 'x' }],
    ['liars_dice', { type: 'bid', quantity: '2', face: 6 }],
    ['liars_dice', { type: 'challenge', padding: true }],
    ['blackjack', { type: 'stand', amount: 1 }],
    ['poker', { type: 'call', amount: 2 }],
    ['trading', { type: 'limit', side: 'buy', price: 100.5, quantity: 1 }],
    ['trading', { type: 'limit', side: 'buy', price: 100, quantity: 1.1 }],
    ['trading', { type: 'limit', side: 'buy', price: 251, quantity: 1 }],
    ['trading', { type: 'market', side: 'buy', quantity: 0 }],
    ['trading', { type: 'market', side: 'buy', quantity: 1, price: 100 }],
    ['trading', { type: 'cancel', orderId: '7' }]
  ];
  for (const [game, action] of invalid) assert.throws(() => canonicalizeAction(game, action), /action|schema|price|cancellation/i);
  assert.throws(() => canonicalizeAction('trading', { type: 'market', side: 'buy', quantity: '1' }),
    (error) => error.code === 'INVALID_GAME_ACTION' && error.publicCode === 'INVALID_GAME_ACTION' && error.status === 400);
});

test('non-trading timeout actions are deterministic and legal for every pending seat', () => {
  const rps = new RpsGame({ players: [human('a'), human('b')], config: { rounds: 10 }, rng: rng('f') });
  assert.deepEqual(rps.timeoutAction('a'), { type: 'play', choice: 'rock' });
  rps.act('a', rps.timeoutAction('a'));
  assert.deepEqual(rps.timeoutAction('b'), { type: 'play', choice: 'rock' });

  const dice = new LiarsDiceGame({ players: [human('a'), human('b')], config: { rounds: 3 }, rng: rng('e') });
  const openingPlayer = dice.players[dice.state.currentIndex].id;
  const opening = dice.timeoutAction(openingPlayer);
  assert.deepEqual(opening, { type: 'bid', quantity: 1, face: 2 });
  dice.act(openingPlayer, opening);
  const challenger = dice.players[dice.state.currentIndex].id;
  assert.deepEqual(dice.timeoutAction(challenger), { type: 'challenge' });

  const blackjack = new BlackjackGame({ players: [human('a'), human('b')], config: { rounds: 2 }, rng: rng('d') });
  const blackjackPlayer = blackjack.currentPlayerId();
  assert.ok(blackjackPlayer);
  assert.deepEqual(blackjack.timeoutAction(blackjackPlayer), { type: 'stand' });
  assert.ok(blackjack.legalActions(blackjackPlayer).some((action) => action.type === 'stand'));

  const poker = new LeducGame({ players: [human('a'), human('b')], config: { rounds: 2 }, rng: rng('c') });
  const first = poker.currentPlayerId();
  assert.deepEqual(poker.timeoutAction(first), { type: 'check' });
  poker.act(first, { type: 'raise' });
  const facingBet = poker.currentPlayerId();
  assert.deepEqual(poker.timeoutAction(facingBet), { type: 'fold' });
  assert.ok(poker.legalActions(facingBet).some((action) => action.type === 'fold'));
});

test('Blackjack advances past terminal split hands instead of exposing an actionless turn', () => {
  const game = new BlackjackGame({ players: [human('a'), human('b')], config: { rounds: 2 }, rng: rng('b') });
  const splitter = game.currentPlayerId();
  game.state.hands[splitter] = [{
    cards: [{ rank: '10', suit: 'S' }, { rank: '10', suit: 'H' }], bet: 10, stood: false, doubled: false, fromSplit: false
  }];
  const filler = Array.from({ length: 52 }, () => ({ rank: '2', suit: 'C' }));
  game.state.shoe = [...filler, { rank: '2', suit: 'D' }, { rank: 'A', suit: 'D' }];
  game.act(splitter, { type: 'split' });
  assert.equal(game.state.hands[splitter][0].stood, true);
  assert.equal(game.state.currentHand, 1);
  assert.equal(game.currentPlayerId(), splitter);
  assert.ok(game.legalActions(splitter).length > 0);

  const bothTerminal = new BlackjackGame({ players: [human('a'), human('b')], config: { rounds: 2 }, rng: rng('a') });
  const secondSplitter = bothTerminal.currentPlayerId();
  bothTerminal.state.hands[secondSplitter] = [{
    cards: [{ rank: '10', suit: 'S' }, { rank: '10', suit: 'H' }], bet: 10, stood: false, doubled: false, fromSplit: false
  }];
  bothTerminal.state.shoe = [...filler, { rank: 'A', suit: 'C' }, { rank: 'A', suit: 'D' }];
  bothTerminal.act(secondSplitter, { type: 'split' });
  assert.ok(bothTerminal.state.hands[secondSplitter].every((hand) => hand.stood));
  assert.ok(bothTerminal.state.phase !== 'players' || bothTerminal.currentPlayerId() !== secondSplitter);
  if (bothTerminal.state.phase === 'players') {
    assert.ok(bothTerminal.legalActions(bothTerminal.currentPlayerId()).length > 0);
  }
});

test('Leduc reveals cards only at showdown and preserves completed hands when voiding an unfinished hand', () => {
  const game = new LeducGame({ players: [human('a'), human('b')], config: { rounds: 2 }, rng: rng('9') });
  while (game.state.hand === 1) game.act(game.currentPlayerId(), { type: 'check' });
  assert.equal(game.state.history[0].reason, 'showdown');
  assert.deepEqual(Object.keys(game.state.history[0].revealed).sort(), ['a', 'b']);
  const completedHand = structuredClone(game.state.history[0]);
  const secondHandStart = structuredClone(game.state.handStartStacks);
  game.act(game.currentPlayerId(), { type: 'raise' });
  game.abortCurrent('session_voided');
  assert.deepEqual(game.state.history[0], completedHand);
  assert.deepEqual(game.state.stacks, secondHandStart);
  assert.equal(game.state.history[1].outcome, 'void');
  assert.equal(game.state.history[1].reason, 'session_voided');
  assert.deepEqual(game.state.history[1].revealed, {});
});

test('trading uses a serializable monotonic countdown and commits a late action as deadline closure', () => {
  let monotonic = 1_000;
  const game = new TradingGame({
    players: [human('a'), bot('maker', 'market_maker')], config: { duration: 30 }, rng: rng('8'),
    monotonicNow: () => monotonic
  });
  monotonic += 5_000;
  assert.equal(game.serialize().remainingMs, 25_000);
  assert.equal(game.pause(), true);
  monotonic += 60_000;
  assert.equal(game.secondsRemaining(), 25);
  assert.equal(game.serialize().remainingMs, 25_000);
  const persisted = structuredClone(game.serialize());
  let restoredMonotonic = 500;
  const restored = new TradingGame({
    players: game.players, config: { duration: 30 }, rng: rng('8'), savedState: persisted,
    monotonicNow: () => restoredMonotonic
  });
  restoredMonotonic += 60_000;
  assert.equal(restored.secondsRemaining(), 25, 'a restored paused clock must not consume wall-clock downtime');
  assert.equal(restored.resume(), true);
  restoredMonotonic += 25_000;
  const result = restored.act('a', { type: 'limit', side: 'buy', price: 1, quantity: 1 });
  assert.deepEqual(result, { type: 'market_closed', reason: 'deadline' });
  assert.equal(restored.state.status, 'completed');
  assert.equal(restored.state.closedReason, 'deadline');
  assert.equal(restored.state.remainingMs, 0);
  assert.equal(restored.state.orders.length, 0);
  assert.equal(restored.state.scored, true);
});

test('trading void clears orders without revealing a terminal value or scoring P/L', () => {
  const voided = new TradingGame({
    players: [human('a'), bot('maker', 'market_maker')], config: { duration: 90 }, rng: rng('4')
  });
  voided.act('maker', { type: 'limit', side: 'sell', price: 100, quantity: 1 });
  voided.act('a', { type: 'market', side: 'buy', quantity: 1 });
  voided.act('maker', { type: 'limit', side: 'buy', price: 90, quantity: 1 });
  assert.ok(voided.state.orders.length > 0);
  voided.abortCurrent('room_voided');
  const voidedView = voided.view('a');
  assert.equal(voided.state.closedReason, 'room_voided');
  assert.equal(voided.state.scored, false);
  assert.equal(voided.state.pnl, null);
  assert.deepEqual(voided.state.orders, []);
  assert.equal(voidedView.terminalValue, null);
  assert.equal(voidedView.pnl, null);

  const settled = new TradingGame({ players: [human('a'), bot('maker')], config: { duration: 90 }, rng: rng('4') });
  settled.forceComplete();
  assert.equal(settled.state.scored, true);
  assert.ok(settled.state.pnl);
  assert.equal(settled.view('a').terminalValue, settled.state.fundamental);
});

test('the deterministic server market maker supplies two-sided liquidity', () => {
  const game = new TradingGame({
    players: [human('a'), bot('maker', 'market_maker')], config: { duration: 90 }, rng: rng('6')
  });
  const firstQuote = game.botTick('maker');
  assert.equal(firstQuote.type, 'limit');
  game.act('maker', firstQuote);
  const secondQuote = game.botTick('maker');
  assert.equal(secondQuote.type, 'limit');
  assert.notEqual(secondQuote.side, firstQuote.side);
  game.act('maker', secondQuote);
  assert.deepEqual(game.state.orders.map((order) => order.side).sort(), ['buy', 'sell']);
  assert.ok(game.state.orders.every((order) => order.ownerKind === 'server'));
  game.act('a', { type: 'market', side: 'buy', quantity: 1 });
  assert.equal(game.state.trades.length, 1);
  assert.equal(game.state.trades[0].seller, 'maker');
});

test('human trading orders cannot settle with humans and student projections omit counterparty metadata', () => {
  const players = [human('a'), human('b'), bot('maker', 'market_maker')];
  const game = new TradingGame({ players, config: { duration: 90 }, rng: rng('7') });
  game.act('a', { type: 'limit', side: 'sell', price: 1, quantity: 1 });
  game.act('b', { type: 'limit', side: 'buy', price: 250, quantity: 1 });
  assert.equal(game.state.trades.length, 0, 'crossed student orders must not transfer wealth');
  assert.equal(game.state.cash.a, 1000);
  assert.equal(game.state.cash.b, 1000);

  game.act('maker', { type: 'market', side: 'buy', quantity: 1 });
  game.act('maker', { type: 'market', side: 'sell', quantity: 1 });
  assert.equal(game.state.trades.length, 2);
  assert.ok(game.state.trades.every((trade) => trade.buyer === 'maker' || trade.seller === 'maker'));
  assert.ok(game.state.trades.every((trade) => !(trade.buyer === 'b' && trade.seller === 'a')));

  game.act('b', { type: 'limit', side: 'buy', price: 100, quantity: 1 });
  const view = game.view('b');
  assert.deepEqual(view.bids, []);
  assert.deepEqual(Object.keys(view.recentTrades[0]).sort(), ['price', 'quantity']);
  assert.deepEqual(Object.keys(view.yourOrders[0]).sort(), ['id', 'price', 'remaining', 'side']);
  assert.equal(JSON.stringify(view).includes('makerOrderId'), false);
  assert.equal(JSON.stringify(view).includes('buyer'), false);
  assert.equal(view.pnlAuthoritative, false);
  assertTradingInvariants(game);
});

test('a student account controlled by a bot never becomes server liquidity', () => {
  const controlledStudent = human('a');
  const game = new TradingGame({
    players: [controlledStudent, human('b'), bot('maker', 'market_maker')], config: { duration: 90 }, rng: rng('f')
  });
  game.act('b', { type: 'limit', side: 'sell', price: 100, quantity: 1 });
  controlledStudent.isBot = true;
  controlledStudent.botKind = 'random';
  game.act('a', { type: 'limit', side: 'buy', price: 100, quantity: 1 });
  assert.equal(game.state.trades.length, 0);
  assert.equal(game.state.orders.find((order) => order.playerId === 'a').ownerKind, 'student');
  assert.equal(game.state.cash.a, 1000);
  assert.equal(game.state.cash.b, 1000);
});

test('long bot simulations preserve game and balance invariants', () => {
  const seeds = ['7', '8', '9'];
  for (const seed of seeds) {
    const two = [bot('a', 'strategy'), bot('b', 'random')];
    const rps = new RpsGame({ players: two, config: { rounds: 100 }, rng: rng(seed) });
    let steps = 0;
    while (!rps.isComplete() && steps < 1000) { const id = rps.pendingBot(); rps.act(id, rps.botAction(id)); steps += 1; }
    assert.equal(rps.state.history.length, 100);

    const five = [bot('a'), bot('b', 'random'), bot('c'), bot('d', 'random'), bot('e')];
    const dice = new LiarsDiceGame({ players: five, config: { rounds: 20 }, rng: rng(seed) });
    steps = 0;
    while (!dice.isComplete() && steps < 5000) { const id = dice.pendingBot(); dice.act(id, dice.botAction(id)); steps += 1; }
    assert.equal(dice.state.history.length, 20);
    assert.ok(steps < 5000);

    const blackjack = new BlackjackGame({ players: five, config: { rounds: 20 }, rng: rng(seed) });
    steps = 0;
    while (!blackjack.isComplete() && steps < 5000) { const id = blackjack.pendingBot(); blackjack.act(id, blackjack.botAction(id)); steps += 1; }
    assert.ok(Object.values(blackjack.state.bankrolls).every((amount) => amount >= 0));
    assert.ok(steps < 5000);

    const poker = new LeducGame({ players: five, config: { rounds: 20 }, rng: rng(seed) });
    steps = 0;
    while (!poker.isComplete() && steps < 5000) { const id = poker.pendingBot(); poker.act(id, poker.botAction(id)); steps += 1; }
    assert.ok(Object.values(poker.state.stacks).every((amount) => amount >= 0));
    assert.ok(Math.abs(Object.values(poker.state.stacks).reduce((sum, amount) => sum + amount, 0) - 200) < 1e-9);

    const marketPlayers = [bot('a'), bot('b', 'random'), bot('c'), bot('d', 'random'), bot('e'), bot('f', 'random')];
    const market = new TradingGame({ players: marketPlayers, config: { duration: 300 }, rng: rng(seed) });
    for (let tick = 0; tick < 300; tick += 1) for (const player of marketPlayers) {
      const action = market.botTick(player.id);
      if (action) market.act(player.id, action);
      assertTradingInvariants(market);
    }
    assert.ok(Object.values(market.state.cash).every((amount) => amount >= 0));
    assert.ok(Object.values(market.state.inventory).every((amount) => amount >= -10 && amount <= 10));
    assert.ok(Math.abs(Object.values(market.state.cash).reduce((sum, amount) => sum + amount, 0) - 6000) < 1e-9);
    assert.equal(Object.values(market.state.inventory).reduce((sum, amount) => sum + amount, 0), 0);
  }
});
