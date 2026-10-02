const RULE_VERSION = 'v3';
const BOT_VERSION = 'v3';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export class GameActionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GameActionError';
    this.code = 'INVALID_GAME_ACTION';
    this.publicCode = 'INVALID_GAME_ACTION';
    this.status = 400;
  }
}

function actionAssert(condition, message) {
  if (!condition) throw new GameActionError(message);
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function canonicalizeAction(game, action) {
  const type = action && typeof action === 'object' && !Array.isArray(action) ? action.type : null;
  if (game === 'rps') {
    actionAssert(hasExactKeys(action, ['type', 'choice']) && type === 'play' &&
      ['rock', 'paper', 'scissors'].includes(action.choice), 'Illegal RPS action');
    return { type: 'play', choice: action.choice };
  }
  if (game === 'liars_dice') {
    if (type === 'challenge') {
      actionAssert(hasExactKeys(action, ['type']), "Invalid Liar's Dice action schema");
      return { type: 'challenge' };
    }
    actionAssert(type === 'bid' && hasExactKeys(action, ['type', 'quantity', 'face']) &&
      Number.isSafeInteger(action.quantity) && action.quantity >= 1 && action.quantity <= 30 &&
      Number.isSafeInteger(action.face) && action.face >= 2 && action.face <= 6,
    "Invalid Liar's Dice action schema");
    return { type: 'bid', quantity: action.quantity, face: action.face };
  }
  if (game === 'blackjack') {
    actionAssert(['hit', 'stand', 'double', 'split'].includes(type) && hasExactKeys(action, ['type']),
      'Invalid blackjack action schema');
    return { type };
  }
  if (game === 'poker') {
    actionAssert(['fold', 'call', 'check', 'raise'].includes(type) && hasExactKeys(action, ['type']),
      'Invalid Leduc action schema');
    return { type };
  }
  if (game === 'trading') {
    if (type === 'cancel') {
      actionAssert(hasExactKeys(action, ['type', 'orderId']) && Number.isSafeInteger(action.orderId) && action.orderId > 0,
        'Invalid cancellation schema');
      return { type: 'cancel', orderId: action.orderId };
    }
    const isOrder = type === 'limit' || type === 'market';
    const keys = type === 'limit' ? ['type', 'side', 'price', 'quantity'] : ['type', 'side', 'quantity'];
    actionAssert(isOrder && hasExactKeys(action, keys) && ['buy', 'sell'].includes(action.side) &&
      Number.isSafeInteger(action.quantity) && action.quantity >= 1 && action.quantity <= 5,
    'Invalid order schema');
    if (type === 'limit') {
      actionAssert(Number.isSafeInteger(action.price) && action.price >= 1 && action.price <= 250,
        'Invalid limit price');
      return { type: 'limit', side: action.side, price: action.price, quantity: action.quantity };
    }
    return { type: 'market', side: action.side, quantity: action.quantity };
  }
  throw new GameActionError(`Unknown game action schema: ${game}`);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function nextIndex(players, current, predicate = () => true) {
  for (let offset = 1; offset <= players.length; offset += 1) {
    const index = (current + offset) % players.length;
    if (predicate(players[index], index)) return index;
  }
  return -1;
}

function factorial(n) {
  let result = 1;
  for (let i = 2; i <= n; i += 1) result *= i;
  return result;
}

function binomialProbability(n, k, p) {
  if (k < 0 || k > n) return 0;
  const choose = factorial(n) / (factorial(k) * factorial(n - k));
  return choose * (p ** k) * ((1 - p) ** (n - k));
}

function binomialTail(n, minimum, p) {
  if (minimum <= 0) return 1;
  let result = 0;
  for (let k = minimum; k <= n; k += 1) result += binomialProbability(n, k, p);
  return result;
}

function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.rank === 'A') {
      total += 11;
      aces += 1;
    } else if (['K', 'Q', 'J'].includes(card.rank)) total += 10;
    else total += Number(card.rank);
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 };
}

function publicPlayer(player) {
  return { id: player.id, name: player.name, isBot: Boolean(player.isBot), botKind: player.isBot ? player.botKind : undefined };
}

class GameBase {
  constructor({ players, config, rng, savedState }) {
    for (const player of players) player.accountKind ??= player.isBot ? 'server' : 'student';
    this.players = players;
    this.config = config;
    this.rng = rng;
    this.state = savedState ?? null;
  }

  player(id) {
    return this.players.find((player) => player.id === id);
  }

  serialize() {
    return this.state;
  }

  isComplete() {
    return this.state.status === 'completed';
  }

  forceComplete() {
    this.state.status = 'completed';
  }

  pendingBot() {
    return null;
  }

  botAction() {
    return null;
  }

  botTick() {
    return null;
  }
}

export class RpsGame extends GameBase {
  constructor(args) {
    super(args);
    if (!this.state) {
      assert(this.players.length === 2, 'RPS requires two seats');
      this.state = {
        status: 'running', round: 1, totalRounds: clamp(Number(this.config.rounds ?? 30), 10, 100),
        submissions: {}, scores: Object.fromEntries(this.players.map((p) => [p.id, 0])), history: []
      };
    }
  }

  legalActions(playerId) {
    if (this.isComplete() || this.state.submissions[playerId]) return [];
    return ['rock', 'paper', 'scissors'].map((choice) => ({ type: 'play', choice }));
  }

  decisionContext(playerId) {
    return {
      round: this.state.round,
      score: this.state.scores[playerId],
      opponentScore: this.state.scores[this.players.find((p) => p.id !== playerId).id],
      previousRounds: this.state.history.slice(-8)
    };
  }

  benchmark(playerId) {
    const opponentId = this.players.find((p) => p.id !== playerId).id;
    const opponentChoices = this.state.history.map((row) => row.choices[opponentId]);
    const counts = { rock: 1, paper: 1, scissors: 1 };
    for (const choice of opponentChoices) counts[choice] += 1;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const likely = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    return {
      method: 'exact-equilibrium-plus-empirical-best-response',
      exact: true,
      nashPolicy: { rock: 1 / 3, paper: 1 / 3, scissors: 1 / 3 },
      observedOpponentPolicy: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value / total])),
      empiricalBestResponse: { rock: 'paper', paper: 'scissors', scissors: 'rock' }[likely],
      note: 'Uniform random play is minimax; empirical best response is exploitive and can itself be exploited.'
    };
  }

  act(playerId, action) {
    action = canonicalizeAction('rps', action);
    actionAssert(action.type === 'play' && this.legalActions(playerId).some((legal) => legal.choice === action.choice), 'Illegal RPS action');
    this.state.submissions[playerId] = action.choice;
    const result = { type: 'choice_committed', playerId };
    if (Object.keys(this.state.submissions).length === 2) {
      const [a, b] = this.players.map((p) => p.id);
      const ca = this.state.submissions[a];
      const cb = this.state.submissions[b];
      const beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
      let winner = null;
      if (ca !== cb) winner = beats[ca] === cb ? a : b;
      if (winner) this.state.scores[winner] += 1;
      const row = { round: this.state.round, choices: { ...this.state.submissions }, winner };
      this.state.history.push(row);
      result.resolution = row;
      this.state.submissions = {};
      if (this.state.round >= this.state.totalRounds) this.state.status = 'completed';
      else this.state.round += 1;
    }
    return result;
  }

  pendingBot() {
    return this.isComplete() ? null : this.players.find((p) => p.isBot && !this.state.submissions[p.id])?.id ?? null;
  }

  timeoutAction(playerId) {
    return this.legalActions(playerId).some((action) => action.type === 'play' && action.choice === 'rock')
      ? { type: 'play', choice: 'rock' }
      : null;
  }

  abortCurrent(reason = 'void') {
    if (this.isComplete()) return false;
    this.state.submissions = {};
    this.state.termination = { reason, outcome: 'void', discardedRound: this.state.round };
    this.state.status = 'completed';
    return true;
  }

  forceComplete() {
    return this.abortCurrent('instructor_end');
  }

  botAction(playerId) {
    const bot = this.player(playerId);
    if (bot.botKind !== 'strategy') return { type: 'play', choice: this.rng.choice(['rock', 'paper', 'scissors']) };
    const opponent = this.players.find((p) => p.id !== playerId);
    const choices = this.state.history.map((row) => row.choices[opponent.id]);
    const counts = { rock: 1, paper: 1, scissors: 1 };
    for (const choice of choices) counts[choice] += 1;
    const likely = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    const best = { rock: 'paper', paper: 'scissors', scissors: 'rock' }[likely];
    return { type: 'play', choice: this.rng.float() < 0.82 ? best : this.rng.choice(['rock', 'paper', 'scissors']) };
  }

  view(playerId) {
    return {
      game: 'rps', rulesVersion: this.config.rulesVersion ?? RULE_VERSION, status: this.state.status, round: this.state.round,
      totalRounds: this.state.totalRounds, players: this.players.map(publicPlayer), scores: this.state.scores,
      youSubmitted: Boolean(this.state.submissions[playerId]), history: this.state.history.slice(-12),
      legalActions: this.legalActions(playerId)
    };
  }
}

export class LiarsDiceGame extends GameBase {
  constructor(args) {
    super(args);
    if (!this.state) {
      assert(this.players.length >= 2 && this.players.length <= 6, "Liar's Dice supports 2-6 seats");
      this.state = {
        status: 'running', round: 1, totalRounds: clamp(Number(this.config.rounds ?? 8), 3, 20),
        scores: Object.fromEntries(this.players.map((p) => [p.id, 0])), currentIndex: 0,
        bid: null, lastBidder: null, dice: {}, history: []
      };
      this.rollRound();
    }
  }

  rollRound() {
    this.state.dice = Object.fromEntries(this.players.map((p) => [p.id, Array.from({ length: 5 }, () => this.rng.int(1, 6))]));
    this.state.bid = null;
    this.state.lastBidder = null;
  }

  legalActions(playerId) {
    if (this.isComplete() || this.players[this.state.currentIndex].id !== playerId) return [];
    const totalDice = this.players.length * 5;
    const bidAtCeiling = this.state.bid?.quantity === totalDice && this.state.bid?.face === 6;
    const result = bidAtCeiling ? [] : [{ type: 'bid', minQuantity: this.state.bid?.quantity ?? 1, faces: [2, 3, 4, 5, 6], maxQuantity: totalDice }];
    if (this.state.bid) result.push({ type: 'challenge' });
    return result;
  }

  probabilityBidTrue(playerId, bid = this.state.bid) {
    if (!bid) return null;
    const known = this.state.dice[playerId].filter((die) => die === 1 || die === bid.face).length;
    const unknown = (this.players.length - 1) * 5;
    return binomialTail(unknown, bid.quantity - known, 1 / 3);
  }

  decisionContext(playerId) {
    return {
      round: this.state.round, yourDice: this.state.dice[playerId], currentBid: this.state.bid,
      probabilityCurrentBidTrue: this.probabilityBidTrue(playerId), scores: this.state.scores,
      currentPlayer: this.players[this.state.currentIndex].id
    };
  }

  benchmark(playerId) {
    const probability = this.probabilityBidTrue(playerId);
    return {
      method: 'exact-binomial-for-challenge-heuristic-for-bid', exact: false,
      probabilityCurrentBidTrue: probability,
      recommendedChallenge: probability == null ? false : probability < 0.45,
      uncertainty: 'Bidding policy is heuristic; challenge probability assumes independent fair unseen dice.'
    };
  }

  isHigherBid(quantity, face) {
    if (!this.state.bid) return quantity >= 1;
    return quantity > this.state.bid.quantity || (quantity === this.state.bid.quantity && face > this.state.bid.face);
  }

  act(playerId, action) {
    action = canonicalizeAction('liars_dice', action);
    actionAssert(this.players[this.state.currentIndex].id === playerId, 'Not your turn');
    if (action.type === 'bid') {
      const { quantity, face } = action;
      actionAssert(Number.isInteger(quantity) && quantity <= this.players.length * 5 && [2, 3, 4, 5, 6].includes(face), 'Invalid bid');
      actionAssert(this.isHigherBid(quantity, face), 'Bid must be higher');
      this.state.bid = { quantity, face };
      this.state.lastBidder = playerId;
      this.state.currentIndex = nextIndex(this.players, this.state.currentIndex);
      return { type: 'bid', playerId, bid: this.state.bid };
    }
    actionAssert(action.type === 'challenge' && this.state.bid, 'Nothing to challenge');
    const challenger = playerId;
    const actual = Object.values(this.state.dice).flat().filter((die) => die === 1 || die === this.state.bid.face).length;
    const bidTrue = actual >= this.state.bid.quantity;
    const winner = bidTrue ? this.state.lastBidder : challenger;
    const loser = bidTrue ? challenger : this.state.lastBidder;
    this.state.scores[winner] += 1;
    this.state.scores[loser] -= 1;
    const resolution = { round: this.state.round, bid: this.state.bid, challenger, bidder: this.state.lastBidder,
      actual, bidTrue, winner, loser, revealedDice: this.state.dice };
    this.state.history.push(resolution);
    if (this.state.round >= this.state.totalRounds) this.state.status = 'completed';
    else {
      this.state.round += 1;
      this.state.currentIndex = this.players.findIndex((p) => p.id === challenger);
      this.rollRound();
    }
    return { type: 'challenge_resolved', resolution };
  }

  pendingBot() {
    const player = this.players[this.state.currentIndex];
    return !this.isComplete() && player.isBot ? player.id : null;
  }

  timeoutAction(playerId) {
    if (!this.legalActions(playerId).length) return null;
    if (this.state.bid) return { type: 'challenge' };
    return { type: 'bid', quantity: 1, face: 2 };
  }

  abortCurrent(reason = 'void') {
    if (this.isComplete()) return false;
    this.state.bid = null;
    this.state.lastBidder = null;
    this.state.dice = Object.fromEntries(this.players.map((player) => [player.id, []]));
    this.state.termination = { reason, outcome: 'void', discardedRound: this.state.round };
    this.state.status = 'completed';
    return true;
  }

  forceComplete() {
    return this.abortCurrent('instructor_end');
  }

  botAction(playerId) {
    const player = this.player(playerId);
    const probability = this.probabilityBidTrue(playerId);
    const totalDice = this.players.length * 5;
    if (this.state.bid?.quantity === totalDice && this.state.bid?.face === 6) return { type: 'challenge' };
    if (this.state.bid && ((player.botKind === 'strategy' && probability < 0.43) || (player.botKind !== 'strategy' && this.rng.float() < 0.22))) {
      return { type: 'challenge' };
    }
    let quantity = this.state.bid?.quantity ?? 1;
    let face = this.state.bid?.face ?? this.rng.int(2, 6);
    if (this.state.bid) {
      if (face < 6 && this.rng.float() < 0.55) face += 1;
      else { quantity = Math.min(totalDice, quantity + 1); face = this.rng.int(2, 6); }
    } else if (player.botKind === 'strategy') {
      const dice = this.state.dice[playerId];
      const counts = [2, 3, 4, 5, 6].map((candidate) => ({ candidate, count: dice.filter((d) => d === 1 || d === candidate).length }));
      face = counts.sort((a, b) => b.count - a.count)[0].candidate;
      quantity = clamp(Math.round(this.players.length * 5 / 3 - 1), 1, totalDice);
    }
    if (!this.isHigherBid(quantity, face)) {
      if (this.state.bid?.quantity === totalDice) {
        quantity = totalDice;
        face = this.state.bid.face + 1;
      } else {
        quantity = (this.state.bid?.quantity ?? 0) + 1;
        face = 2;
      }
    }
    return { type: 'bid', quantity, face };
  }

  view(playerId) {
    return {
      game: 'liars_dice', rulesVersion: this.config.rulesVersion ?? RULE_VERSION, status: this.state.status,
      round: this.state.round, totalRounds: this.state.totalRounds, players: this.players.map(publicPlayer),
      scores: this.state.scores, currentPlayer: this.players[this.state.currentIndex]?.id,
      currentBid: this.state.bid, yourDice: this.state.dice[playerId], history: this.state.history.slice(-4),
      legalActions: this.legalActions(playerId), probabilityCurrentBidTrue: this.probabilityBidTrue(playerId)
    };
  }
}

export class BlackjackGame extends GameBase {
  constructor(args) {
    super(args);
    if (!this.state) {
      this.state = {
        status: 'running', round: 0, totalRounds: clamp(Number(this.config.rounds ?? 5), 1, 20),
        bankrolls: Object.fromEntries(this.players.map((p) => [p.id, 200])), shoe: [], dealer: [], hands: {},
        currentIndex: 0, currentHand: 0, history: [], phase: 'dealing', roundStartBankrolls: null
      };
      this.startRound();
    } else {
      if (!this.state.roundStartBankrolls && !this.isComplete()) {
        this.state.roundStartBankrolls = this.inferRoundStartBankrolls();
      }
    }
  }

  inferRoundStartBankrolls() {
    const bankrolls = { ...this.state.bankrolls };
    for (const player of this.players) {
      const committed = (this.state.hands?.[player.id] ?? []).reduce((sum, hand) => sum + Number(hand.bet ?? 0), 0);
      bankrolls[player.id] = (bankrolls[player.id] ?? 0) + committed;
    }
    return bankrolls;
  }

  makeShoe() {
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const suits = ['S', 'H', 'D', 'C'];
    const cards = [];
    for (let deck = 0; deck < 6; deck += 1) for (const suit of suits) for (const rank of ranks) cards.push({ rank, suit });
    this.state.shoe = this.rng.shuffle(cards);
  }

  draw() {
    if (this.state.shoe.length < 52) this.makeShoe();
    return this.state.shoe.pop();
  }

  startRound() {
    this.state.round += 1;
    if (this.state.shoe.length < 52) this.makeShoe();
    this.state.dealer = [];
    this.state.hands = {};
    const active = this.players.filter((p) => this.state.bankrolls[p.id] >= 10);
    if (!active.length || this.state.round > this.state.totalRounds) {
      this.state.status = 'completed';
      return;
    }
    this.state.roundStartBankrolls = { ...this.state.bankrolls };
    for (const player of active) {
      this.state.bankrolls[player.id] -= 10;
      this.state.hands[player.id] = [{ cards: [], bet: 10, stood: false, doubled: false, fromSplit: false }];
    }
    for (let pass = 0; pass < 2; pass += 1) {
      for (const player of active) this.state.hands[player.id][0].cards.push(this.draw());
      this.state.dealer.push(this.draw());
    }
    this.state.phase = 'players';
    this.state.currentIndex = this.players.findIndex((p) => this.state.hands[p.id]);
    this.state.currentHand = 0;
    this.skipNaturals();
  }

  skipNaturals() {
    while (this.state.phase === 'players') {
      const player = this.players[this.state.currentIndex];
      const hand = this.state.hands[player.id]?.[this.state.currentHand];
      if (hand && !hand.stood && handValue(hand.cards).total < 21) break;
      if (!hand) { this.advanceTurn(); break; }
      hand.stood = true;
      this.advanceTurn();
    }
  }

  currentPlayerId() {
    return this.state.phase === 'players' ? this.players[this.state.currentIndex]?.id : null;
  }

  legalActions(playerId) {
    if (this.isComplete() || this.currentPlayerId() !== playerId) return [];
    const hand = this.state.hands[playerId][this.state.currentHand];
    const value = handValue(hand.cards).total;
    if (value >= 21) return [];
    const actions = [{ type: 'hit' }, { type: 'stand' }];
    if (hand.cards.length === 2 && this.state.bankrolls[playerId] >= hand.bet) actions.push({ type: 'double' });
    if (hand.cards.length === 2 && this.state.hands[playerId].length === 1 && this.state.bankrolls[playerId] >= hand.bet &&
        hand.cards[0].rank === hand.cards[1].rank) actions.push({ type: 'split' });
    return actions;
  }

  decisionContext(playerId) {
    const hand = this.state.hands[playerId]?.[this.state.currentHand];
    return {
      round: this.state.round, hand: hand?.cards, handValue: hand ? handValue(hand.cards) : null,
      dealerUpCard: this.state.dealer[0], bankroll: this.state.bankrolls[playerId], activeHand: this.state.currentHand
    };
  }

  basicAction(playerId) {
    const legal = this.legalActions(playerId).map((a) => a.type);
    const hand = this.state.hands[playerId][this.state.currentHand];
    const value = handValue(hand.cards);
    const dealerRank = this.state.dealer[0].rank;
    const dealer = dealerRank === 'A' ? 11 : ['K', 'Q', 'J'].includes(dealerRank) ? 10 : Number(dealerRank);
    if (legal.includes('split') && ['A', '8'].includes(hand.cards[0].rank)) return 'split';
    if (value.soft) {
      if (value.total >= 19) return 'stand';
      if (value.total === 18) {
        if (legal.includes('double') && dealer >= 3 && dealer <= 6) return 'double';
        return dealer >= 9 ? 'hit' : 'stand';
      }
      if (legal.includes('double') && value.total >= 15 && dealer >= 4 && dealer <= 6) return 'double';
      return 'hit';
    }
    if (value.total >= 17) return 'stand';
    if (value.total <= 8) return 'hit';
    if (value.total === 9) return legal.includes('double') && dealer >= 3 && dealer <= 6 ? 'double' : 'hit';
    if (value.total === 10) return legal.includes('double') && dealer <= 9 ? 'double' : 'hit';
    if (value.total === 11) return legal.includes('double') ? 'double' : 'hit';
    if (value.total === 12) return dealer >= 4 && dealer <= 6 ? 'stand' : 'hit';
    return dealer >= 2 && dealer <= 6 ? 'stand' : 'hit';
  }

  benchmark(playerId) {
    return { method: 'deterministic-basic-strategy-approximation', exact: false,
      recommendedAction: this.basicAction(playerId), uncertainty: 'Rule-specific approximation; EV values are not claimed as exact for this ruleset.' };
  }

  act(playerId, action) {
    action = canonicalizeAction('blackjack', action);
    const legal = this.legalActions(playerId).map((a) => a.type);
    actionAssert(legal.includes(action.type), 'Illegal blackjack action');
    let hand = this.state.hands[playerId][this.state.currentHand];
    if (action.type === 'hit') {
      hand.cards.push(this.draw());
      if (handValue(hand.cards).total >= 21) { hand.stood = true; this.advanceTurn(); }
    } else if (action.type === 'stand') {
      hand.stood = true;
      this.advanceTurn();
    } else if (action.type === 'double') {
      this.state.bankrolls[playerId] -= hand.bet;
      hand.bet *= 2;
      hand.doubled = true;
      hand.cards.push(this.draw());
      hand.stood = true;
      this.advanceTurn();
    } else if (action.type === 'split') {
      this.state.bankrolls[playerId] -= hand.bet;
      const [first, second] = hand.cards;
      const firstHand = { cards: [first, this.draw()], bet: hand.bet, stood: false, doubled: false, fromSplit: true };
      const secondHand = { cards: [second, this.draw()], bet: hand.bet, stood: false, doubled: false, fromSplit: true };
      if (first.rank === 'A' || handValue(firstHand.cards).total >= 21) firstHand.stood = true;
      if (second.rank === 'A' || handValue(secondHand.cards).total >= 21) secondHand.stood = true;
      this.state.hands[playerId] = [firstHand, secondHand];
      hand = firstHand;
      if (hand.stood) this.advanceTurn();
    }
    return { type: 'blackjack_action', playerId, action: action.type, handValue: handValue(hand.cards) };
  }

  advanceTurn() {
    if (this.state.phase !== 'players') return;
    const playerId = this.players[this.state.currentIndex].id;
    const hands = this.state.hands[playerId] ?? [];
    if (this.state.currentHand + 1 < hands.length) {
      this.state.currentHand += 1;
      if (hands[this.state.currentHand].stood) this.advanceTurn();
      return;
    }
    const next = nextIndex(this.players, this.state.currentIndex, (p) => Boolean(this.state.hands[p.id]));
    if (next < 0 || next <= this.state.currentIndex) {
      this.state.phase = 'dealer';
      this.resolveDealer();
    } else {
      this.state.currentIndex = next;
      this.state.currentHand = 0;
      this.skipNaturals();
    }
  }

  resolveDealer({ continueMatch = true } = {}) {
    while (true) {
      const value = handValue(this.state.dealer);
      if (value.total > 17 || (value.total === 17)) break;
      this.state.dealer.push(this.draw());
    }
    const dealerValue = handValue(this.state.dealer).total;
    const dealerBlackjack = this.state.dealer.length === 2 && dealerValue === 21;
    const outcomes = {};
    for (const player of this.players) {
      const hands = this.state.hands[player.id] ?? [];
      outcomes[player.id] = [];
      for (const hand of hands) {
        const value = handValue(hand.cards).total;
        const natural = hand.cards.length === 2 && value === 21 && !hand.fromSplit;
        let result = 'loss';
        if (value > 21) result = 'bust';
        else if (natural && !dealerBlackjack) { result = 'blackjack'; this.state.bankrolls[player.id] += hand.bet * 2.5; }
        else if (dealerBlackjack) {
          if (natural) { result = 'push'; this.state.bankrolls[player.id] += hand.bet; }
        }
        else if (dealerValue > 21 || value > dealerValue) { result = 'win'; this.state.bankrolls[player.id] += hand.bet * 2; }
        else if (value === dealerValue) { result = 'push'; this.state.bankrolls[player.id] += hand.bet; }
        outcomes[player.id].push({ cards: hand.cards, value, bet: hand.bet, result });
      }
    }
    this.state.history.push({ round: this.state.round, dealer: this.state.dealer, dealerValue, outcomes });
    this.state.phase = 'settled';
    if (!continueMatch || this.state.round >= this.state.totalRounds) this.state.status = 'completed';
    else this.startRound();
  }

  pendingBot() {
    const id = this.currentPlayerId();
    return id && this.player(id).isBot ? id : null;
  }

  timeoutAction(playerId) {
    return this.legalActions(playerId).some((action) => action.type === 'stand') ? { type: 'stand' } : null;
  }

  botAction(playerId) {
    const bot = this.player(playerId);
    if (bot.botKind === 'strategy') return { type: this.basicAction(playerId) };
    return this.rng.choice(this.legalActions(playerId));
  }

  abortCurrent(reason = 'void') {
    if (this.isComplete()) return false;
    this.state.bankrolls = { ...(this.state.roundStartBankrolls ?? this.inferRoundStartBankrolls()) };
    this.state.dealer = [];
    this.state.hands = {};
    this.state.currentIndex = 0;
    this.state.currentHand = 0;
    this.state.phase = 'aborted';
    this.state.termination = { reason, outcome: 'void', discardedRound: this.state.round };
    this.state.status = 'completed';
    return true;
  }

  forceComplete() {
    return this.abortCurrent('instructor_end');
  }

  view(playerId) {
    const revealDealer = this.state.status === 'completed' || this.state.phase === 'settled';
    return {
      game: 'blackjack', rulesVersion: this.config.rulesVersion ?? RULE_VERSION, status: this.state.status, phase: this.state.phase,
      round: this.state.round, totalRounds: this.state.totalRounds, players: this.players.map(publicPlayer),
      bankrolls: this.state.bankrolls, dealer: revealDealer ? this.state.dealer : [this.state.dealer[0], { hidden: true }],
      hands: { [playerId]: this.state.hands[playerId] ?? [] }, currentPlayer: this.currentPlayerId(), currentHand: this.state.currentHand,
      legalActions: this.legalActions(playerId), history: this.state.history.slice(-3)
    };
  }
}

export class LeducGame extends GameBase {
  constructor(args) {
    super(args);
    if (!this.state) {
      this.state = {
        status: 'running', hand: 0, totalHands: clamp(Number(this.config.rounds ?? 5), 1, 20),
        stacks: Object.fromEntries(this.players.map((p) => [p.id, 40])), dealerIndex: this.players.length - 1,
        history: [], privateCards: {}, publicCard: null, deck: [], pot: 0, round: 1, folded: {},
        contribution: {}, currentBet: 0, raises: 0, pending: [], currentIndex: 0, actionHistory: [], lastShowdown: null,
        handStartStacks: null
      };
      this.startHand();
    } else if (!this.state.handStartStacks && !this.isComplete()) this.state.handStartStacks = this.inferHandStartStacks();
  }

  inferHandStartStacks() {
    const stacks = { ...this.state.stacks };
    const dealtPlayers = Object.keys(this.state.privateCards ?? {});
    for (const playerId of dealtPlayers) stacks[playerId] = (stacks[playerId] ?? 0) + 1;
    let accountedPot = dealtPlayers.length;
    for (const action of this.state.actionHistory ?? []) {
      const nextPot = Number(action.pot);
      const payment = Number.isFinite(nextPot) ? Math.max(0, nextPot - accountedPot) : 0;
      if (payment && Object.hasOwn(stacks, action.playerId)) stacks[action.playerId] += payment;
      if (Number.isFinite(nextPot)) accountedPot = nextPot;
    }
    return stacks;
  }

  startHand() {
    this.state.hand += 1;
    const funded = this.players.filter((p) => this.state.stacks[p.id] >= 1);
    if (this.state.hand > this.state.totalHands || funded.length < 2) { this.state.status = 'completed'; return; }
    this.state.handStartStacks = { ...this.state.stacks };
    this.state.dealerIndex = nextIndex(this.players, this.state.dealerIndex, (p) => funded.some((f) => f.id === p.id));
    const ranks = Array.from({ length: this.players.length + 1 }, (_, index) => index);
    this.state.deck = this.rng.shuffle(ranks.flatMap((rank) => [{ rank, suit: 0 }, { rank, suit: 1 }]));
    this.state.privateCards = {};
    this.state.folded = {};
    this.state.contribution = {};
    this.state.pot = 0;
    for (const player of this.players) {
      if (this.state.stacks[player.id] >= 1) {
        this.state.stacks[player.id] -= 1;
        this.state.pot += 1;
        this.state.privateCards[player.id] = this.state.deck.pop();
        this.state.folded[player.id] = false;
        this.state.contribution[player.id] = 0;
      } else this.state.folded[player.id] = true;
    }
    this.state.publicCard = null;
    this.state.round = 1;
    this.state.currentBet = 0;
    this.state.raises = 0;
    this.state.actionHistory = [];
    this.resetPending();
  }

  activePlayers() {
    return this.players.filter((p) => this.state.privateCards[p.id] && !this.state.folded[p.id]);
  }

  resetPending() {
    this.state.pending = this.activePlayers().map((p) => p.id);
    this.state.currentIndex = nextIndex(this.players, this.state.dealerIndex,
      (p) => this.state.pending.includes(p.id));
  }

  currentPlayerId() {
    return this.state.pending.length ? this.players[this.state.currentIndex]?.id : null;
  }

  legalActions(playerId) {
    if (this.isComplete() || this.currentPlayerId() !== playerId) return [];
    const toCall = this.state.currentBet - (this.state.contribution[playerId] ?? 0);
    const actions = [];
    if (toCall > 0) {
      actions.push({ type: 'fold' });
      if (this.state.stacks[playerId] >= toCall) actions.push({ type: 'call', amount: toCall });
    }
    else actions.push({ type: 'check' });
    const raiseAmount = this.state.round === 1 ? 2 : 4;
    if (this.state.raises < 2 && this.state.stacks[playerId] >= toCall + raiseAmount) actions.push({ type: 'raise', amount: toCall + raiseAmount });
    return actions;
  }

  decisionContext(playerId) {
    return {
      hand: this.state.hand, bettingRound: this.state.round, privateCard: this.state.privateCards[playerId],
      publicCard: this.state.publicCard, pot: this.state.pot,
      toCall: this.state.currentBet - (this.state.contribution[playerId] ?? 0), stack: this.state.stacks[playerId],
      raises: this.state.raises, publicActionHistory: this.state.actionHistory
    };
  }

  benchmark(playerId) {
    const legal = this.legalActions(playerId).map((action) => action.type);
    const privateRank = this.state.privateCards[playerId]?.rank ?? 0;
    const pair = this.state.publicCard?.rank === privateRank;
    const normalized = privateRank / this.players.length;
    const toCall = this.state.currentBet - (this.state.contribution[playerId] ?? 0);
    let recommendation = legal.includes('check') ? 'check' : legal[0] ?? null;
    if (pair || normalized > 0.72) recommendation = legal.includes('raise') ? 'raise' :
      (legal.includes('call') ? 'call' : legal.includes('check') ? 'check' : legal[0] ?? null);
    else if (toCall > 0 && normalized < 0.35) recommendation = 'fold';
    else recommendation = toCall ? (legal.includes('call') ? 'call' : legal[0] ?? null) :
      (normalized > 0.55 && legal.includes('raise') ? 'raise' : legal.includes('check') ? 'check' : legal[0] ?? null);
    if (!legal.includes(recommendation)) recommendation = legal[0] ?? null;
    return {
      method: 'private-rank-and-pair-heuristic', exact: false, recommendedAction: recommendation,
      handClass: pair ? 'pair' : `high-rank-${privateRank}`,
      uncertainty: 'Uses private rank, visible pairs, and whether a call is required; does not calculate equity or pot odds.'
    };
  }

  act(playerId, action) {
    action = canonicalizeAction('poker', action);
    const legal = this.legalActions(playerId).map((a) => a.type);
    actionAssert(legal.includes(action.type), 'Illegal Leduc action');
    const hand = this.state.hand;
    const toCall = this.state.currentBet - this.state.contribution[playerId];
    if (action.type === 'fold') {
      this.state.folded[playerId] = true;
      this.state.pending = this.state.pending.filter((id) => id !== playerId);
    } else if (action.type === 'call' || action.type === 'check') {
      if (toCall > 0) {
        this.state.stacks[playerId] -= toCall;
        this.state.contribution[playerId] += toCall;
        this.state.pot += toCall;
      }
      this.state.pending = this.state.pending.filter((id) => id !== playerId);
    } else if (action.type === 'raise') {
      const raiseAmount = this.state.round === 1 ? 2 : 4;
      const payment = toCall + raiseAmount;
      this.state.stacks[playerId] -= payment;
      this.state.contribution[playerId] += payment;
      this.state.pot += payment;
      this.state.currentBet += raiseAmount;
      this.state.raises += 1;
      this.state.pending = this.activePlayers().map((p) => p.id).filter((id) => id !== playerId);
    }
    this.state.actionHistory.push({ round: this.state.round, playerId, action: action.type, pot: this.state.pot });
    let resolution = null;
    if (this.activePlayers().length === 1) resolution = this.resolveHand('folds');
    else if (this.state.pending.length === 0) resolution = this.advanceBettingRound();
    else {
      const next = nextIndex(this.players, this.state.currentIndex, (p) => this.state.pending.includes(p.id));
      this.state.currentIndex = next;
    }
    return { type: 'leduc_action', playerId, action: action.type, hand,
      pot: resolution?.pot ?? this.state.pot, ...(resolution ? { resolution } : {}) };
  }

  advanceBettingRound() {
    if (this.state.round === 1) {
      this.state.publicCard = this.state.deck.pop();
      this.state.round = 2;
      this.state.currentBet = 0;
      this.state.raises = 0;
      this.state.contribution = Object.fromEntries(this.players.map((p) => [p.id, 0]));
      this.resetPending();
      return null;
    }
    return this.resolveHand('showdown');
  }

  resolveHand(reason, { continueMatch = true } = {}) {
    const active = this.activePlayers();
    let winners = active;
    if (active.length > 1) {
      const strength = (player) => {
        const rank = this.state.privateCards[player.id].rank;
        return (this.state.publicCard?.rank === rank ? 1000 : 0) + rank;
      };
      const best = Math.max(...active.map(strength));
      winners = active.filter((p) => strength(p) === best);
    }
    const share = this.state.pot / winners.length;
    for (const winner of winners) this.state.stacks[winner.id] += share;
    const showdown = {
      hand: this.state.hand, reason, publicCard: this.state.publicCard,
      revealed: reason === 'showdown' ? Object.fromEntries(active.map((p) => [p.id, this.state.privateCards[p.id]])) : {},
      winners: winners.map((p) => p.id), pot: this.state.pot, actionHistory: this.state.actionHistory
    };
    this.state.lastShowdown = showdown;
    this.state.history.push(showdown);
    if (!continueMatch || this.state.hand >= this.state.totalHands) this.state.status = 'completed';
    else this.startHand();
    return showdown;
  }

  pendingBot() {
    const id = this.currentPlayerId();
    return id && this.player(id).isBot ? id : null;
  }

  timeoutAction(playerId) {
    const legal = this.legalActions(playerId).map((action) => action.type);
    if (legal.includes('check')) return { type: 'check' };
    if (legal.includes('fold')) return { type: 'fold' };
    return null;
  }

  botAction(playerId) {
    const legal = this.legalActions(playerId);
    const bot = this.player(playerId);
    if (bot.botKind !== 'strategy') return { type: this.rng.choice(legal).type };
    const recommendation = this.benchmark(playerId).recommendedAction;
    if (this.rng.float() < 0.8 && legal.some((a) => a.type === recommendation)) return { type: recommendation };
    return { type: this.rng.choice(legal).type };
  }

  abortCurrent(reason = 'void') {
    if (this.isComplete()) return false;
    const refundedPot = this.state.pot;
    this.state.stacks = { ...(this.state.handStartStacks ?? this.inferHandStartStacks()) };
    this.state.pot = 0;
    this.state.currentBet = 0;
    this.state.raises = 0;
    this.state.pending = [];
    this.state.contribution = Object.fromEntries(this.players.map((player) => [player.id, 0]));
    const resolution = {
      hand: this.state.hand, reason, outcome: 'void', publicCard: this.state.publicCard,
      revealed: {}, winners: [], pot: 0, refundedPot, actionHistory: this.state.actionHistory
    };
    this.state.lastShowdown = resolution;
    this.state.history.push(resolution);
    this.state.status = 'completed';
    return true;
  }

  forceComplete() {
    return this.abortCurrent('instructor_end');
  }

  view(playerId) {
    return {
      game: 'poker', rulesVersion: this.config.rulesVersion ?? RULE_VERSION, status: this.state.status, hand: this.state.hand,
      totalHands: this.state.totalHands, players: this.players.map(publicPlayer), stacks: this.state.stacks,
      dealer: this.players[this.state.dealerIndex]?.id, bettingRound: this.state.round, pot: this.state.pot,
      publicCard: this.state.publicCard, yourPrivateCard: this.state.privateCards[playerId],
      folded: this.state.folded, currentPlayer: this.currentPlayerId(), currentBet: this.state.currentBet,
      contribution: this.state.contribution, raises: this.state.raises, actionHistory: this.state.actionHistory,
      lastShowdown: this.state.lastShowdown, legalActions: this.legalActions(playerId)
    };
  }
}

export class TradingGame extends GameBase {
  constructor(args) {
    super(args);
    this.monotonicNow = typeof args.monotonicNow === 'function'
      ? args.monotonicNow
      : () => globalThis.performance?.now?.() ?? Date.now();
    this.clockAnchor = this.monotonicNow();
    if (!this.state) {
      const fundamental = this.rng.int(80, 120);
      const startedAt = Date.now();
      const remainingMs = clamp(Number(this.config.duration ?? 90), 30, 300) * 1000;
      this.state = {
        status: 'running', startedAt, endsAt: startedAt + remainingMs, remainingMs, pausedAt: null,
        fundamental, cash: Object.fromEntries(this.players.map((p) => [p.id, 1000])),
        inventory: Object.fromEntries(this.players.map((p) => [p.id, 0])),
        signals: Object.fromEntries(this.players.map((p) => [p.id, Math.round(fundamental + this.rng.normal(0, 8))])),
        orders: [], trades: [], nextOrderId: 1, pnl: null, scored: false, closedReason: null
      };
    } else {
      if (!Number.isFinite(this.state.remainingMs)) {
        const wallReference = this.state.pausedAt ?? Date.now();
        this.state.remainingMs = Math.max(0, Number(this.state.endsAt ?? wallReference) - wallReference);
      }
      this.state.remainingMs = Math.max(0, this.state.remainingMs);
      this.state.closedReason ??= this.isComplete() ? 'restored_complete' : null;
      this.state.scored ??= this.isComplete() && this.state.pnl != null;
    }
    for (const order of this.state.orders) {
      order.ownerKind ??= this.player(order.playerId)?.accountKind === 'server' ? 'server' : 'student';
    }
  }

  syncClock(now = this.monotonicNow()) {
    const current = Number(now);
    assert(Number.isFinite(current), 'Monotonic clock must be finite');
    if (!this.isComplete() && this.state.pausedAt == null) {
      this.state.remainingMs = Math.max(0, this.state.remainingMs - Math.max(0, current - this.clockAnchor));
      this.state.endsAt = Date.now() + this.state.remainingMs;
    }
    this.clockAnchor = current;
    return this.state.remainingMs;
  }

  serialize() {
    this.syncClock();
    return this.state;
  }

  pause(now = this.monotonicNow()) {
    if (this.isComplete()) return false;
    if (this.checkTime(now)) return false;
    if (this.state.pausedAt == null) this.state.pausedAt = Date.now();
    this.clockAnchor = Number(now);
    return true;
  }

  resume(now = this.monotonicNow()) {
    if (this.isComplete() || this.state.pausedAt == null) return false;
    this.state.pausedAt = null;
    this.clockAnchor = Number(now);
    this.state.endsAt = Date.now() + this.state.remainingMs;
    return true;
  }

  legalActions(playerId) {
    if (this.isComplete()) return [];
    this.syncClock();
    if (this.state.remainingMs <= 0) return [];
    return [
      { type: 'limit', sides: ['buy', 'sell'], minPrice: 1, maxPrice: 250, minQuantity: 1, maxQuantity: 5 },
      { type: 'market', sides: ['buy', 'sell'], minQuantity: 1, maxQuantity: 5 },
      { type: 'cancel', orderIds: this.state.orders.filter((o) => o.playerId === playerId).map((o) => o.id) }
    ];
  }

  decisionContext(playerId) {
    const resources = this.availableResources(playerId);
    return {
      secondsRemaining: this.secondsRemaining(),
      privateSignal: this.state.signals[playerId], cash: this.state.cash[playerId], inventory: this.state.inventory[playerId],
      reservedCash: resources.reservedCash, availableCash: resources.availableCash,
      reservedBuyQuantity: resources.reservedBuyQuantity, reservedSellQuantity: resources.reservedSellQuantity,
      availableBuyQuantity: resources.availableBuyQuantity, availableSellQuantity: resources.availableSellQuantity,
      bestBid: this.bestBid(playerId)?.price ?? null, bestAsk: this.bestAsk(playerId)?.price ?? null,
      recentTrades: this.state.trades.slice(-10).map((trade) => this.publicTrade(trade)),
      yourOpenOrders: this.state.orders.filter((order) => order.playerId === playerId).map((order) => this.ownOrder(order))
    };
  }

  benchmark(playerId) {
    const signal = this.state.signals[playerId];
    const inventory = this.state.inventory[playerId];
    const reservation = signal - inventory * 0.8;
    return {
      method: 'inventory-skewed-private-signal-heuristic', exact: false,
      reservationPrice: Number(reservation.toFixed(2)), suggestedBid: Math.floor(reservation - 2), suggestedAsk: Math.ceil(reservation + 2),
      uncertainty: 'Private signal is noisy and the heuristic is not an optimal-control solution.'
    };
  }

  executableOrders(playerId, side) {
    const playerIsServer = this.player(playerId)?.accountKind === 'server';
    return this.state.orders.filter((order) => order.side === side && order.playerId !== playerId &&
      (playerIsServer || order.ownerKind === 'server'));
  }

  bestBid(playerId) {
    return this.executableOrders(playerId, 'buy')
      .sort((a, b) => b.price - a.price || a.id - b.id)[0];
  }

  bestAsk(playerId) {
    return this.executableOrders(playerId, 'sell')
      .sort((a, b) => a.price - b.price || a.id - b.id)[0];
  }

  publicTrade(trade) {
    return { price: trade.price, quantity: trade.quantity };
  }

  bookOrder(order) {
    return { price: order.price, remaining: order.remaining };
  }

  ownOrder(order) {
    return { id: order.id, side: order.side, price: order.price, remaining: order.remaining };
  }

  matchingOrder(incoming) {
    const opposite = incoming.side === 'buy' ? 'sell' : 'buy';
    return this.executableOrders(incoming.playerId, opposite).sort((a, b) => incoming.side === 'buy'
      ? a.price - b.price || a.id - b.id
      : b.price - a.price || a.id - b.id)[0];
  }

  availableResources(playerId) {
    const own = this.state.orders.filter((order) => order.playerId === playerId);
    const reservedCash = own.filter((order) => order.side === 'buy')
      .reduce((sum, order) => sum + order.price * order.remaining, 0);
    const reservedBuyQuantity = own.filter((order) => order.side === 'buy')
      .reduce((sum, order) => sum + order.remaining, 0);
    const reservedSellQuantity = own.filter((order) => order.side === 'sell')
      .reduce((sum, order) => sum + order.remaining, 0);
    return {
      reservedCash,
      availableCash: this.state.cash[playerId] - reservedCash,
      reservedBuyQuantity,
      reservedSellQuantity,
      availableBuyQuantity: 10 - this.state.inventory[playerId] - reservedBuyQuantity,
      availableSellQuantity: this.state.inventory[playerId] + 10 - reservedSellQuantity
    };
  }

  canReserveLimit(playerId, side, price, quantity) {
    const resources = this.availableResources(playerId);
    if (side === 'buy') return resources.availableCash >= price * quantity && resources.availableBuyQuantity >= quantity;
    return resources.availableSellQuantity >= quantity;
  }

  assertRestingOrderCollateral(order) {
    assert(order.orderType === 'limit' && Number.isFinite(order.price) && Number.isInteger(order.remaining) && order.remaining > 0,
      'Resting order invariant violated');
    const others = this.state.orders.filter((candidate) => candidate.playerId === order.playerId && candidate.id !== order.id);
    if (order.side === 'buy') {
      const otherCash = others.filter((candidate) => candidate.side === 'buy')
        .reduce((sum, candidate) => sum + candidate.price * candidate.remaining, 0);
      const otherQuantity = others.filter((candidate) => candidate.side === 'buy')
        .reduce((sum, candidate) => sum + candidate.remaining, 0);
      assert(this.state.cash[order.playerId] - otherCash >= order.price * order.remaining &&
        10 - this.state.inventory[order.playerId] - otherQuantity >= order.remaining,
      'Resting buy collateral invariant violated');
    } else {
      const otherQuantity = others.filter((candidate) => candidate.side === 'sell')
        .reduce((sum, candidate) => sum + candidate.remaining, 0);
      assert(this.state.inventory[order.playerId] + 10 - otherQuantity >= order.remaining,
        'Resting sell collateral invariant violated');
    }
  }

  act(playerId, action) {
    action = canonicalizeAction('trading', action);
    const deadlineResult = this.checkTime();
    if (deadlineResult) return deadlineResult;
    actionAssert(!this.isComplete(), 'Market is closed');
    const player = this.player(playerId);
    actionAssert(player, 'Unknown trader');
    if (action.type === 'cancel') {
      const { orderId } = action;
      const order = this.state.orders.find((candidate) => candidate.id === orderId && candidate.playerId === playerId);
      actionAssert(order, 'Order not found');
      this.state.orders = this.state.orders.filter((candidate) => candidate.id !== orderId);
      return { type: 'order_cancelled', playerId, orderId, cancelledQuantity: order.remaining };
    }
    const { quantity } = action;
    const price = action.type === 'market' ? (action.side === 'buy' ? Infinity : 0) : action.price;
    if (action.type === 'limit') actionAssert(this.canReserveLimit(playerId, action.side, price, quantity), 'Order exceeds available cash or inventory capacity');
    const incoming = { id: this.state.nextOrderId++, playerId, side: action.side, price, quantity, remaining: quantity,
      createdAt: Date.now(), orderType: action.type, ownerKind: player.accountKind === 'server' ? 'server' : 'student' };
    this.match(incoming);
    if (incoming.remaining > 0 && action.type === 'limit') this.state.orders.push(incoming);
    const filledQuantity = quantity - incoming.remaining;
    return { type: 'order_accepted', playerId, requestedQuantity: quantity, filledQuantity,
      restingQuantity: action.type === 'limit' ? incoming.remaining : 0,
      cancelledQuantity: action.type === 'market' ? incoming.remaining : 0,
      order: { id: incoming.id, side: incoming.side, price: Number.isFinite(price) ? price : 'market',
        quantity: incoming.quantity, remaining: incoming.remaining } };
  }

  cancelOpenOrders(playerId) {
    const cancelled = this.state.orders.filter((order) => order.playerId === playerId);
    this.state.orders = this.state.orders.filter((order) => order.playerId !== playerId);
    return {
      orders: cancelled.length,
      quantity: cancelled.reduce((sum, order) => sum + order.remaining, 0),
    };
  }

  match(incoming) {
    while (incoming.remaining > 0) {
      const resting = this.matchingOrder(incoming);
      if (!resting) break;
      const crosses = incoming.orderType === 'market' || (incoming.side === 'buy' ? resting.price <= incoming.price : resting.price >= incoming.price);
      if (!crosses) break;
      this.assertRestingOrderCollateral(resting);
      const buyer = incoming.side === 'buy' ? incoming.playerId : resting.playerId;
      const seller = incoming.side === 'sell' ? incoming.playerId : resting.playerId;
      let quantity = Math.min(incoming.remaining, resting.remaining);
      if (incoming.orderType === 'market') {
        const resources = this.availableResources(incoming.playerId);
        if (incoming.side === 'buy') quantity = Math.min(quantity, resources.availableBuyQuantity,
          Math.floor(resources.availableCash / resting.price));
        else quantity = Math.min(quantity, resources.availableSellQuantity);
      }
      if (quantity < 1) break;
      this.state.cash[buyer] -= resting.price * quantity;
      this.state.inventory[buyer] += quantity;
      this.state.cash[seller] += resting.price * quantity;
      this.state.inventory[seller] -= quantity;
      incoming.remaining -= quantity;
      resting.remaining -= quantity;
      this.state.trades.push({ price: resting.price, quantity, buyer, seller, timestamp: Date.now(),
        makerOrderId: resting.id, takerOrderId: incoming.id,
        buyOrderId: incoming.side === 'buy' ? incoming.id : resting.id,
        sellOrderId: incoming.side === 'sell' ? incoming.id : resting.id,
        aggressorSide: incoming.side });
      if (resting.remaining === 0) this.state.orders = this.state.orders.filter((o) => o.id !== resting.id);
    }
  }

  botTick(playerId) {
    this.checkTime();
    if (this.isComplete()) return null;
    const bot = this.player(playerId);
    const signal = this.state.signals[playerId];
    const inventory = this.state.inventory[playerId];
    const resources = this.availableResources(playerId);
    const sides = [];
    if (resources.availableBuyQuantity >= 1 && resources.availableCash >= 1) sides.push('buy');
    if (resources.availableSellQuantity >= 1) sides.push('sell');
    if (!sides.length) {
      const ownOrders = this.state.orders.filter((order) => order.playerId === playerId);
      return ownOrders.length ? { type: 'cancel', orderId: this.rng.choice(ownOrders).id } : null;
    }
    if (bot.botKind === 'market_maker') {
      const ownOrders = this.state.orders.filter((order) => order.playerId === playerId);
      const midpoint = clamp(Math.round(signal - inventory * 0.75), 3, 248);
      const quotes = { buy: midpoint - 2, sell: midpoint + 2 };
      const stale = ownOrders.find((order) => order.price !== quotes[order.side]);
      if (stale) return { type: 'cancel', orderId: stale.id };
      if (!ownOrders.some((order) => order.side === 'buy') && sides.includes('buy')) {
        const quantity = Math.min(5, resources.availableBuyQuantity, Math.floor(resources.availableCash / quotes.buy));
        if (quantity >= 1) return { type: 'limit', side: 'buy', price: quotes.buy, quantity };
      }
      if (!ownOrders.some((order) => order.side === 'sell') && sides.includes('sell')) {
        const quantity = Math.min(5, resources.availableSellQuantity);
        if (quantity >= 1) return { type: 'limit', side: 'sell', price: quotes.sell, quantity };
      }
      return null;
    }
    if (bot.botKind === 'strategy') {
      const reservation = signal - inventory * 0.9;
      const preferred = inventory > 4 ? 'sell' : inventory < -4 ? 'buy' : this.rng.choice(sides);
      const side = sides.includes(preferred) ? preferred : sides[0];
      const bestOpposite = side === 'buy' ? this.bestAsk(playerId) : this.bestBid(playerId);
      if (bestOpposite && (side !== 'buy' || resources.availableCash >= bestOpposite.price) &&
          ((side === 'buy' && bestOpposite.price < reservation - 1) || (side === 'sell' && bestOpposite.price > reservation + 1))) {
        return { type: 'market', side, quantity: 1 };
      }
      const rawPrice = clamp(Math.round(reservation + (side === 'buy' ? -2 : 2)), 1, 250);
      const price = side === 'buy' ? Math.min(rawPrice, Math.floor(resources.availableCash)) : rawPrice;
      return { type: 'limit', side, quantity: 1, price };
    }
    const side = this.rng.choice(sides);
    const rawPrice = clamp(Math.round(signal + this.rng.normal(side === 'buy' ? -3 : 3, 6)), 1, 250);
    const price = side === 'buy' ? Math.min(rawPrice, Math.floor(resources.availableCash)) : rawPrice;
    const capacity = side === 'buy' ? resources.availableBuyQuantity : resources.availableSellQuantity;
    const cashQuantity = side === 'buy' ? Math.floor(resources.availableCash / price) : 2;
    return { type: 'limit', side, quantity: Math.max(1, Math.min(this.rng.int(1, 2), capacity, cashQuantity)), price };
  }

  checkTime(now = this.monotonicNow()) {
    if (this.isComplete() || this.state.pausedAt != null) return null;
    if (this.syncClock(now) > 0) return null;
    this.forceComplete('deadline');
    return { type: 'market_closed', reason: 'deadline' };
  }

  secondsRemaining() {
    if (this.isComplete()) return 0;
    this.syncClock();
    return Math.max(0, Math.ceil(this.state.remainingMs / 1000));
  }

  forceComplete(reason = 'instructor_end') {
    if (this.isComplete()) return false;
    this.state.remainingMs = 0;
    this.state.orders = [];
    this.state.pnl = {};
    for (const player of this.players) {
      this.state.pnl[player.id] = Number((this.state.cash[player.id] + this.state.inventory[player.id] * this.state.fundamental - 1000).toFixed(2));
    }
    this.state.scored = true;
    this.state.closedReason = reason;
    this.state.status = 'completed';
    return true;
  }

  abortCurrent(reason = 'void') {
    if (this.isComplete()) return false;
    this.state.remainingMs = 0;
    this.state.orders = [];
    this.state.pnl = null;
    this.state.scored = false;
    this.state.closedReason = reason;
    this.state.status = 'completed';
    return true;
  }

  view(playerId) {
    const bids = this.executableOrders(playerId, 'buy').sort((a, b) => b.price - a.price || a.id - b.id)
      .slice(0, 12).map((order) => this.bookOrder(order));
    const asks = this.executableOrders(playerId, 'sell').sort((a, b) => a.price - b.price || a.id - b.id)
      .slice(0, 12).map((order) => this.bookOrder(order));
    const resources = this.availableResources(playerId);
    return {
      game: 'trading', rulesVersion: this.config.rulesVersion ?? RULE_VERSION, status: this.state.status,
      secondsRemaining: this.secondsRemaining(),
      players: this.players.map(publicPlayer), bids, asks, recentTrades: this.state.trades.slice(-15).map((trade) => this.publicTrade(trade)),
      yourSignal: this.state.signals[playerId], yourCash: this.state.cash[playerId], yourInventory: this.state.inventory[playerId],
      yourReservedCash: resources.reservedCash, yourAvailableCash: resources.availableCash,
      yourReservedBuyQuantity: resources.reservedBuyQuantity, yourReservedSellQuantity: resources.reservedSellQuantity,
      yourAvailableBuyQuantity: resources.availableBuyQuantity, yourAvailableSellQuantity: resources.availableSellQuantity,
      yourOrders: this.state.orders.filter((o) => o.playerId === playerId).map((order) => this.ownOrder(order)),
      terminalValue: this.isComplete() && this.state.scored ? this.state.fundamental : null,
      pnl: this.isComplete() && this.state.scored ? this.state.pnl : null,
      pnlAuthoritative: false,
      legalActions: this.legalActions(playerId)
    };
  }
}

export function createGame(game, args) {
  const constructors = {
    rps: RpsGame,
    liars_dice: LiarsDiceGame,
    blackjack: BlackjackGame,
    poker: LeducGame,
    trading: TradingGame
  };
  const Constructor = constructors[game];
  if (!Constructor) throw new Error(`Unknown game: ${game}`);
  return new Constructor(args);
}

export const GAME_METADATA = {
  rps: { name: 'Iterated Rock Paper Scissors', liveTableSize: 2, botSeats: 2, defaultRounds: 30, minRounds: 10, maxRounds: 100 },
  liars_dice: { name: "Classroom Liar's Dice", liveTableSize: 5, botSeats: 5, defaultRounds: 8, minRounds: 3, maxRounds: 20 },
  blackjack: { name: 'Blackjack', liveTableSize: 5, botSeats: 3, defaultRounds: 5, minRounds: 1, maxRounds: 20 },
  poker: { name: 'Fixed-Limit Leduc Poker', liveTableSize: 5, botSeats: 3, defaultRounds: 5, minRounds: 1, maxRounds: 20 },
  trading: { name: 'Continuous Double-Auction Trading', liveTableSize: 15, botSeats: 6, defaultDuration: 90, minDuration: 30, maxDuration: 300 }
};

export const VERSIONS = { rules: RULE_VERSION, bots: BOT_VERSION, generator: 'sha256-counter-v1' };

export const GAME_RULE_SUMMARIES = {
  rps: [
    'Two seats make simultaneous hidden rock, paper, or scissors submissions for 10-100 rounds; a win is one point and a draw is zero.',
    'A missed decision commits rock as the documented deterministic timeout action and makes that result ineligible for competitive grading.',
    'Uniform one-third play is the exact minimax policy. The strategy bot estimates observed action frequencies with Laplace smoothing, mostly best-responds, and retains exploration.'
  ],
  liars_dice: [
    'Two to six seats each roll five dice per round. Ones are wild for faces 2-6; bids increase quantity or keep quantity and increase face.',
    'A challenge scores +1/-1 between winner and loser; dice reset and nobody is eliminated. The strategy benchmark uses exact binomial truth probability but its bidding policy is heuristic.'
  ],
  blackjack: [
    'Six-deck shared-dealer blackjack uses a fixed 10-unit wager, dealer stands on soft 17, blackjack pays 3:2, and hit/stand/double/one split are supported.',
    'There is no insurance, surrender, or side bet. The strategy benchmark is a transparent rule-specific basic-strategy approximation, not a claimed exact EV table.'
  ],
  poker: [
    'Generalized fixed-limit Leduc has one private card, one public card, a 1-unit ante, raises of 2 then 4, and at most two raises per betting round.',
    'A private/public pair beats a non-pair, otherwise high private rank wins. Multiplayer recommendations use private rank, visible pairs, and whether a call is required; they do not calculate equity or pot odds.'
  ],
  trading: [
    'The continuous double auction uses price-time priority, resting-order execution price, gross collateral reservations, immediate-or-cancel market orders, and prohibits self-trading.',
    'Student orders execute only against server-controlled liquidity, never directly against another student order. Each displayed order book shows only counterpart orders that its viewer can trade against.',
    'Each trader has a noisy private common-value signal; inventory is liquidated at the hidden terminal value. P/L is educational and non-authoritative for grading; strategy quotes are inventory-skewed signal heuristics, not optimal-control solutions.'
  ]
};
