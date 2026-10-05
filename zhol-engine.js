(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Zhol = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// ============================================================
// Zhol rules engine. Seats 0..3 go to the right (the direction of play).
// Cards: { id, rank, suit }. rank 1 = ace ... 13 = king. A joker has rank null and suit null.
// ============================================================

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const OPENING_MINIMUM = 51;
const TOTAL_ROUNDS = 8;

let random = Math.random;
function setRandom(fn) { random = fn || Math.random; }

const isJoker = (c) => c.rank === null;

function handPoints(c) {
  if (c.rank === null) return 25;
  return (c.rank === 1 || c.rank >= 10) ? 10 : c.rank;
}

function shuffle(arr, rng) {
  const r = rng || random;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// ---------- Deck and deal ----------

function makeFullDeck() {
  const cards = [];
  let id = 0;
  for (let d = 0; d < 2; d++)
    for (const suit of SUITS)
      for (let rank = 1; rank <= 13; rank++) cards.push({ id: id++, rank, suit });
  for (let j = 0; j < 4; j++) cards.push({ id: id++, rank: null, suit: null });
  return cards;
}

/** Shuffle, cut, deal. First player (right of the dealer) gets 15 cards, the others 14. 51 cards stay in the pile. */
function dealRound(dealer, rng) {
  const r = rng || random;
  const deck = shuffle(makeFullDeck(), r);
  const first = (dealer + 1) % 4;
  const cutter = (dealer + 3) % 4;

  const cutIndex = 40 + Math.floor(r() * 29);          // roughly half
  const cutCard = deck.splice(cutIndex - 1, 1)[0];
  const hands = [[], [], [], []];
  let faceUp = null;
  if (isJoker(cutCard)) hands[cutter].push(cutCard); else faceUp = cutCard;

  for (let step = 0; step < 4; step++) {
    const seat = (first + step) % 4;
    let count = step === 0 ? 3 : 2;
    if (seat === cutter && isJoker(cutCard)) count -= 1;
    for (let k = 0; k < count; k++) hands[seat].push(deck.shift());
  }
  for (let round = 0; round < 6; round++)
    for (let step = 0; step < 4; step++) {
      const seat = (first + step) % 4;
      hands[seat].push(deck.shift());
      hands[seat].push(deck.shift());
    }
  if (faceUp) deck.push(faceUp);
  return { hands, drawPile: deck, faceUpBottomCard: faceUp, dealer, firstPlayer: first, cutter };
}

// ---------- Melds ----------

function positionPoints(p) {
  if (p === 1) return 1;
  if (p >= 2 && p <= 9) return p;
  return 10;
}

/** A set: 3 or 4 cards of the same rank, all in different suits. Jokers fill the gaps. */
function makeSet(cards) {
  if (cards.length !== 3 && cards.length !== 4) return null;
  const naturals = cards.filter((c) => !isJoker(c));
  if (naturals.length === 0) return null;
  const rank = naturals[0].rank;
  if (!naturals.every((c) => c.rank === rank)) return null;
  const suits = naturals.map((c) => c.suit);
  if (new Set(suits).size !== suits.length) return null;
  const perCard = rank === 1 ? 10 : positionPoints(rank);
  return { kind: 'set', cards: cards.slice(), positions: [], points: perCard * cards.length };
}

/** Every way these cards can make a run (bridge): same suit, in order, ace low or high, 3 to 14 cards. */
function makeRuns(cards) {
  const n = cards.length;
  if (n < 3 || n > 14) return [];
  const naturals = cards.filter((c) => !isJoker(c));
  const jokers = cards.filter(isJoker);
  if (naturals.length === 0) return [];
  const suit = naturals[0].suit;
  if (!naturals.every((c) => c.suit === suit)) return [];

  const results = [];
  for (let start = 1; start <= 15 - n; start++) {
    const end = start + n - 1;
    const slots = new Array(n).fill(null);
    const place = (index) => {
      if (index === naturals.length) {
        const left = jokers.slice();
        const ordered = [], positions = [];
        let total = 0;
        for (let i = 0; i < n; i++) {
          const position = start + i;
          ordered.push(slots[i] !== null ? slots[i] : left.pop());
          positions.push(position);
          total += positionPoints(position);
        }
        results.push({ kind: 'run', cards: ordered, positions, points: total });
        return;
      }
      const card = naturals[index];
      const options = card.rank === 1 ? [1, 14] : [card.rank];
      for (const position of options) {
        if (position >= start && position <= end && slots[position - start] === null) {
          slots[position - start] = card;
          place(index + 1);
          slots[position - start] = null;
        }
      }
    };
    place(0);
  }
  return results;
}

/** The valid meld with the most points these cards can make, or null. */
function bestMeld(cards) {
  const options = makeRuns(cards);
  const set = makeSet(cards);
  if (set) options.push(set);
  let best = null;
  for (const m of options) if (best === null || m.points > best.points) best = m;
  return best;
}

// ---------- Opening ----------

function popcount(x) { let c = 0; while (x) { x &= x - 1; c++; } return c; }
function ctz(x) { return 31 - Math.clz32(x & -x); }

/** Every valid meld inside a hand: { mask, meld }. Only groups of one suit or one rank (plus jokers) are tried. */
function meldCandidates(hand) {
  const n = hand.length;
  const jokerPositions = [];
  let naturalMask = 0;
  for (let i = 0; i < n; i++) {
    if (isJoker(hand[i])) jokerPositions.push(i); else naturalMask |= 1 << i;
  }
  const masks = new Set();
  const addGroups = (positions, minSize, maxSize) => {
    const count = positions.length;
    if (count < minSize) return;
    for (let pick = 1; pick < (1 << count); pick++) {
      const size = popcount(pick);
      if (size < minSize || size > maxSize) continue;
      let mask = 0;
      for (let k = 0; k < count; k++) if (pick & (1 << k)) mask |= 1 << positions[k];
      if (mask & naturalMask) masks.add(mask);
    }
  };
  for (const suit of SUITS) {
    const suited = [];
    for (let i = 0; i < n; i++) if (hand[i].suit === suit) suited.push(i);
    if (suited.length) addGroups(suited.concat(jokerPositions), 3, 14);
  }
  for (let rank = 1; rank <= 13; rank++) {
    const ranked = [];
    for (let i = 0; i < n; i++) if (hand[i].rank === rank) ranked.push(i);
    if (ranked.length) addGroups(ranked.concat(jokerPositions), 3, 4);
  }
  const result = [];
  for (const mask of Array.from(masks).sort((a, b) => a - b)) {
    const cards = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) cards.push(hand[i]);
    const meld = bestMeld(cards);
    if (meld) result.push({ mask, meld });
  }
  return result;
}

/**
 * The way to lay down melds from this hand that gives the most points.
 * mustUse: a card that has to be inside the melds (the thrown card you took to open).
 * keepOneToDiscard: at least one card must stay out of the melds.
 * Returns { melds, points, leftover, canOpen } or null when mustUse fits no meld.
 */
function bestOpening(hand, mustUse, keepOneToDiscard) {
  if (keepOneToDiscard === undefined) keepOneToDiscard = true;
  const n = hand.length;
  if (n === 0 || n > 16) return null;
  const full = (1 << n) - 1;
  const candidates = meldCandidates(hand);

  const byLow = [];
  for (let i = 0; i < n; i++) byLow.push([]);
  candidates.forEach((c, index) => byLow[ctz(c.mask)].push(index));

  const best = new Int32Array(full + 1);
  const choice = new Int32Array(full + 1).fill(-1);
  for (let mask = 1; mask <= full; mask++) {
    const low = ctz(mask);
    best[mask] = best[mask & ~(1 << low)];
    choice[mask] = -1;
    for (const index of byLow[low]) {
      const m = candidates[index].mask;
      if ((m & mask) === m) {
        const value = best[mask & ~m] + candidates[index].meld.points;
        if (value > best[mask]) { best[mask] = value; choice[mask] = index; }
      }
    }
  }
  const collect = (start) => {
    let mask = start;
    const picked = [];
    while (mask !== 0) {
      const index = choice[mask];
      if (index === -1) mask &= ~(1 << ctz(mask));
      else { picked.push(candidates[index]); mask &= ~candidates[index].mask; }
    }
    return picked;
  };

  let bestValue = -1;
  let bestPicked = [];
  if (mustUse) {
    const requiredIndex = hand.findIndex((c) => c.id === mustUse.id);
    if (requiredIndex < 0) return null;
    for (const candidate of candidates) {
      if (!(candidate.mask & (1 << requiredIndex))) continue;
      const rest = full & ~candidate.mask;
      if (keepOneToDiscard) {
        if (rest === 0) continue;
        for (let d = 0; d < n; d++) {
          if (!(rest & (1 << d))) continue;
          const restMask = rest & ~(1 << d);
          const value = candidate.meld.points + best[restMask];
          if (value > bestValue) { bestValue = value; bestPicked = [candidate].concat(collect(restMask)); }
        }
      } else {
        const value = candidate.meld.points + best[rest];
        if (value > bestValue) { bestValue = value; bestPicked = [candidate].concat(collect(rest)); }
      }
    }
    if (bestValue < 0) return null;
  } else if (keepOneToDiscard) {
    for (let d = 0; d < n; d++) {
      const restMask = full & ~(1 << d);
      if (best[restMask] > bestValue) { bestValue = best[restMask]; bestPicked = collect(restMask); }
    }
  } else {
    bestValue = best[full];
    bestPicked = collect(full);
  }

  let used = 0;
  for (const c of bestPicked) used |= c.mask;
  const leftover = hand.filter((_, i) => !(used & (1 << i)));
  return { melds: bestPicked.map((c) => c.meld), points: bestValue, leftover, canOpen: bestValue >= OPENING_MINIMUM };
}

/** Can this 15-card hand lay down 14 cards in melds (51+ points) and keep one to throw? That is a Hand. */
function handCloseGroups(hand) {
  const n = hand.length;
  if (n !== 15) return null;
  const full = (1 << n) - 1;
  const maskOf = [], pointsOf = [];
  const byLow = [];
  for (let i = 0; i < n; i++) byLow.push([]);
  for (const c of meldCandidates(hand)) {
    byLow[ctz(c.mask)].push(maskOf.length);
    maskOf.push(c.mask);
    pointsOf.push(c.meld.points);
  }
  const best = new Int32Array(full + 1).fill(-1);
  const choice = new Int32Array(full + 1).fill(-1);
  best[0] = 0;
  for (let mask = 1; mask <= full; mask++) {
    const low = ctz(mask);
    for (const index of byLow[low]) {
      const m = maskOf[index];
      if ((m & mask) === m && best[mask & ~m] >= 0) {
        const value = best[mask & ~m] + pointsOf[index];
        if (value > best[mask]) { best[mask] = value; choice[mask] = index; }
      }
    }
  }
  let bestMask = -1, bestValue = -1;
  for (let d = 0; d < n; d++) {
    const mask = full & ~(1 << d);
    if (best[mask] > bestValue) { bestValue = best[mask]; bestMask = mask; }
  }
  if (bestMask < 0 || bestValue < OPENING_MINIMUM) return null;
  const groups = [];
  let mask = bestMask;
  while (mask !== 0) {
    const m = maskOf[choice[mask]];
    groups.push(hand.filter((_, i) => m & (1 << i)));
    mask &= ~m;
  }
  return groups;
}

// ---------- Melds on the table ----------

function makeTableMeld(meld, owner) {
  return { owner, kind: meld.kind, cards: meld.cards.slice(), positions: meld.positions.slice() };
}
function runSuit(m) { const c = m.cards.find((x) => !isJoker(x)); return c ? c.suit : null; }
function setRank(m) { const c = m.cards.find((x) => !isJoker(x)); return c ? c.rank : null; }

/** "Sell" a card onto a meld. Returns the new meld, or null if it doesn't fit. */
function adding(m, card, atHighEnd) {
  if (atHighEnd === undefined) atHighEnd = true;
  if (m.kind === 'run') {
    if (m.cards.length >= 14) return null;
    const low = m.positions[0], high = m.positions[m.positions.length - 1];
    const fits = (position) => {
      if (isJoker(card)) return true;
      if (card.suit !== runSuit(m)) return false;
      return card.rank === position || (card.rank === 1 && position === 14);
    };
    const lowFits = low > 1 && fits(low - 1);
    const highFits = high < 14 && fits(high + 1);
    if (highFits && (atHighEnd || !lowFits))
      return { owner: m.owner, kind: m.kind, cards: m.cards.concat([card]), positions: m.positions.concat([high + 1]) };
    if (lowFits)
      return { owner: m.owner, kind: m.kind, cards: [card].concat(m.cards), positions: [low - 1].concat(m.positions) };
    return null;
  }
  if (m.cards.length >= 4) return null;
  if (!isJoker(card)) {
    if (card.rank !== setRank(m)) return null;
    if (m.cards.some((x) => !isJoker(x) && x.suit === card.suit)) return null;
  }
  return { owner: m.owner, kind: m.kind, cards: m.cards.concat([card]), positions: [] };
}

/**
 * Take a joker off a meld by laying real card(s) in its place. Returns { meld, joker } or null.
 * Run: the one real card the joker stands for.
 * Set: a real card for EVERY suit the joker could be (that makes a full set of four).
 */
function takingJoker(m, given) {
  if (!m.cards.some(isJoker)) return null;
  if (given.length === 0 || given.some(isJoker)) return null;
  if (m.kind === 'run') {
    if (given.length !== 1 || given[0].suit !== runSuit(m)) return null;
    const rank = given[0].rank;
    const index = m.cards.findIndex((c, i) => isJoker(c) && (m.positions[i] === rank || (rank === 1 && m.positions[i] === 14)));
    if (index < 0) return null;
    const cards = m.cards.slice();
    const joker = cards[index];
    cards[index] = given[0];
    return { meld: { owner: m.owner, kind: m.kind, cards, positions: m.positions.slice() }, joker };
  }
  const naturals = m.cards.filter((c) => !isJoker(c));
  if (naturals.length === 0) return null;
  const rank = naturals[0].rank;
  const jokerCount = m.cards.length - naturals.length;
  const missing = 4 - naturals.length;
  if (given.length !== missing - jokerCount + 1) return null;
  const onTable = new Set(naturals.map((c) => c.suit));
  const givenSuits = given.map((c) => c.suit);
  if (!given.every((c) => c.rank === rank)) return null;
  if (new Set(givenSuits).size !== givenSuits.length) return null;
  if (givenSuits.some((s) => onTable.has(s))) return null;
  const removed = m.cards.find(isJoker);
  const others = m.cards.filter((c) => isJoker(c) && c.id !== removed.id);
  return { meld: { owner: m.owner, kind: m.kind, cards: naturals.concat(given, others), positions: [] }, joker: removed };
}

/** "E shitur": a card that fits a meld on the table. Jokers don't count here. */
function isSellable(card, table) {
  if (isJoker(card)) return false;
  return table.some((m) => adding(m, card) !== null);
}

/** The cards the player may throw. A joker can't be thrown unless it is the last card.
 *  A player who hasn't opened can't throw a card that fits a meld on the table. */
function legalDiscards(hand, hasOpened, table) {
  if (hand.length === 1) return hand.slice();
  let allowed = hand.filter((c) => !isJoker(c));
  if (!hasOpened) allowed = allowed.filter((c) => !isSellable(c, table));
  return allowed.length === 0 ? hand.slice() : allowed;
}

// ---------- Closing and scoring ----------

const CLOSER_POINTS = { normal: -40, normalWithJoker: -80, hand: -120, handWithJoker: -200, ngjyre: -800 };
const isBigClose = (t) => t === 'hand' || t === 'handWithJoker' || t === 'ngjyre';

/** A Ngjyre: 14 cards in one suit, ace low, 2 to king, ace high. No joker. */
function isNgjyre(meld) {
  return meld.kind === 'run' && meld.cards.length === 14 && !meld.cards.some(isJoker);
}

function closeType(turn) {
  const withJoker = isJoker(turn.closingCard);
  if (!turn.openedBeforeThisTurn && turn.ownMelds.some(isNgjyre)) return 'ngjyre';
  if (!turn.openedBeforeThisTurn && turn.cardsPlacedOnOthersMelds.length === 0)
    return withJoker ? 'handWithJoker' : 'hand';
  return withJoker ? 'normalWithJoker' : 'normal';
}

function roundScores(closer, type, players) {
  return players.map((p, seat) => {
    if (seat === closer) return CLOSER_POINTS[type];
    if (!p.hasOpened) return isBigClose(type) ? 200 : 100;
    const total = p.cardsInHand.reduce((s, c) => s + handPoints(c), 0);
    return isBigClose(type) ? total * 2 : total;
  });
}

function dealerForRound(round, firstDealer) { return (firstDealer + round) % 4; }

// ---------- One round ----------

class MoveError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function removing(cards, hand) {
  const remaining = hand.slice();
  for (const card of cards) {
    const index = remaining.findIndex((c) => c.id === card.id);
    if (index < 0) return null;
    remaining.splice(index, 1);
  }
  return remaining;
}

class GameRound {
  constructor(deal) {
    this.players = deal.hands.map((h) => ({ hand: h.slice(), hasOpened: false }));
    this.drawPile = deal.drawPile.slice();
    this.discardPile = [];
    this.table = [];
    this.bottomCard = deal.faceUpBottomCard;
    this.current = deal.firstPlayer;
    this.phase = 'firstDiscard';       // firstDiscard | draw | play | finished
    this.turn = { openedBeforeThisTurn: false, meldsLaid: [], cardsPlacedOnOthersMelds: [] };
    this.result = null;
  }

  clone() {
    const copy = Object.create(GameRound.prototype);
    Object.assign(copy, JSON.parse(JSON.stringify(this)));
    return copy;
  }

  /** Do one move. If it is not allowed this throws a MoveError and nothing changes. */
  perform(move) {
    const next = this.clone();
    next._apply(move);
    Object.assign(this, next);
  }

  _apply(move) {
    const t = move.type;
    switch (this.phase) {
      case 'finished':
        throw new MoveError('wrongPhase');
      case 'firstDiscard':
        if (t !== 'discard') throw new MoveError('wrongPhase');
        return this._discard(move.card);
      case 'draw':
        if (t === 'drawFromPile') return this._drawFromPile();
        if (t === 'takeDiscard') return this._takeDiscard();
        if (t === 'takeDiscardAndOpen') return this._takeDiscardAndOpen(move.groups);
        if (t === 'takeBottomCard') return this._takeBottomCard();
        throw new MoveError('wrongPhase');
      case 'play':
        if (t === 'layDown') return this._layDown(move.groups);
        if (t === 'sell') return this._sell(move.card, move.meld, move.atHighEnd);
        if (t === 'takeJoker') return this._takeJoker(move.meld, move.giving);
        if (t === 'discard') return this._discard(move.card);
        throw new MoveError('wrongPhase');
    }
  }

  get me() { return this.players[this.current]; }

  _drawFromPile() {
    if (this.drawPile.length === 0) this._refill();
    if (this.drawPile.length === 0) throw new MoveError('noCardsLeft');
    this.me.hand.push(this.drawPile.shift());
    this._forgetBottomCardIfGone();
    this.phase = 'play';
  }
  _refill() {
    if (this.discardPile.length <= 1) throw new MoveError('noCardsLeft');
    const top = this.discardPile.pop();
    this.drawPile = shuffle(this.discardPile.slice());
    this.discardPile = [top];
    this.bottomCard = null;
  }
  _forgetBottomCardIfGone() {
    if (this.bottomCard) {
      const last = this.drawPile[this.drawPile.length - 1];
      if (!last || last.id !== this.bottomCard.id) this.bottomCard = null;
    }
  }
  _takeDiscard() {
    if (!this.me.hasOpened) throw new MoveError('mustOpenFirst');
    if (this.discardPile.length === 0) throw new MoveError('discardPileEmpty');
    this.me.hand.push(this.discardPile.pop());
    this.phase = 'play';
  }
  _takeDiscardAndOpen(groups) {
    if (this.me.hasOpened) throw new MoveError('wrongPhase');
    if (this.discardPile.length === 0) throw new MoveError('discardPileEmpty');
    const card = this.discardPile[this.discardPile.length - 1];
    if (!groups.some((g) => g.some((c) => c.id === card.id))) throw new MoveError('discardMustBeInMelds');
    this.discardPile.pop();
    this.me.hand.push(card);
    this._layDown(groups);
    this.phase = 'play';
  }
  _takeBottomCard() {
    const last = this.drawPile[this.drawPile.length - 1];
    if (!this.bottomCard || !last || last.id !== this.bottomCard.id) throw new MoveError('noBottomCard');
    if (this.me.hasOpened) throw new MoveError('bottomCardIsNotAHand');
    const hand = this.me.hand.concat([this.bottomCard]);
    if (!handCloseGroups(hand)) throw new MoveError('bottomCardIsNotAHand');
    this.drawPile.pop();
    this.me.hand = hand;
    this.bottomCard = null;
    this.phase = 'play';
  }
  _layDown(groups) {
    if (!groups || groups.length === 0) throw new MoveError('notAValidMeld');
    let remaining = this.me.hand;
    const melds = [];
    for (const group of groups) {
      const left = removing(group, remaining);
      if (left === null) throw new MoveError('cardNotInHand');
      const meld = bestMeld(group);
      if (meld === null) throw new MoveError('notAValidMeld');
      remaining = left;
      melds.push(meld);
    }
    if (remaining.length === 0) throw new MoveError('mustKeepOneCard');
    if (!this.me.hasOpened) {
      const total = melds.reduce((s, m) => s + m.points, 0);
      if (total < OPENING_MINIMUM) throw new MoveError('notEnoughToOpen');
      this.me.hasOpened = true;
    }
    this.me.hand = remaining;
    for (const meld of melds) this.table.push(makeTableMeld(meld, this.current));
    this.turn.meldsLaid = this.turn.meldsLaid.concat(melds);
  }
  _sell(card, index, atHighEnd) {
    if (!this.me.hasOpened) throw new MoveError('mustOpenFirst');
    if (!(index >= 0 && index < this.table.length)) throw new MoveError('badMeldIndex');
    const remaining = removing([card], this.me.hand);
    if (remaining === null) throw new MoveError('cardNotInHand');
    if (remaining.length === 0) throw new MoveError('mustKeepOneCard');
    const updated = adding(this.table[index], card, atHighEnd === undefined ? true : atHighEnd);
    if (updated === null) throw new MoveError('cardCantBeSold');
    if (this.table[index].owner !== this.current) this.turn.cardsPlacedOnOthersMelds.push(card);
    this.table[index] = updated;
    this.me.hand = remaining;
  }
  _takeJoker(index, giving) {
    if (!this.me.hasOpened) throw new MoveError('mustOpenFirst');
    if (!(index >= 0 && index < this.table.length)) throw new MoveError('badMeldIndex');
    const remaining = removing(giving, this.me.hand);
    if (remaining === null) throw new MoveError('cardNotInHand');
    const swap = takingJoker(this.table[index], giving);
    if (swap === null) throw new MoveError('cannotTakeJoker');
    if (this.table[index].owner !== this.current) this.turn.cardsPlacedOnOthersMelds.push(...giving);
    this.table[index] = swap.meld;
    this.me.hand = remaining.concat([swap.joker]);
  }
  _discard(card) {
    const hand = this.me.hand;
    if (!hand.some((c) => c.id === card.id)) throw new MoveError('cardNotInHand');
    const allowed = legalDiscards(hand, this.me.hasOpened, this.table);
    if (!allowed.some((c) => c.id === card.id)) throw new MoveError('illegalDiscard');
    this.me.hand = hand.filter((c) => c.id !== card.id);
    if (this.me.hand.length === 0) this._closeRound(card);
    else {
      this.discardPile.push(card);
      this._startTurn((this.current + 1) % 4);
    }
  }
  _startTurn(seat) {
    this.current = seat;
    this.phase = 'draw';
    this.turn = { openedBeforeThisTurn: this.players[seat].hasOpened, meldsLaid: [], cardsPlacedOnOthersMelds: [] };
  }
  _closeRound(closingCard) {
    this.discardPile.push(closingCard);
    const type = closeType({
      openedBeforeThisTurn: this.turn.openedBeforeThisTurn,
      ownMelds: this.turn.meldsLaid,
      cardsPlacedOnOthersMelds: this.turn.cardsPlacedOnOthersMelds,
      closingCard,
    });
    const states = this.players.map((p) => ({ hasOpened: p.hasOpened, cardsInHand: p.hand }));
    this.result = { closer: this.current, closeType: type, scores: roundScores(this.current, type, states) };
    this.phase = 'finished';
  }
}

// ---------- The match: 8 rounds ----------

class ZholMatch {
  constructor() {
    this.firstDealer = Math.floor(random() * 4);          // the first dealer is random
    this.totals = [0, 0, 0, 0];
    this.roundsPlayed = 0;
    this.round = new GameRound(dealRound(this.firstDealer));
  }
  get isFinished() { return this.roundsPlayed >= TOTAL_ROUNDS; }
  get leaders() {
    const lowest = Math.min(...this.totals);
    return this.totals.map((t, i) => (t === lowest ? i : -1)).filter((i) => i >= 0);
  }
  get dealer() { return dealerForRound(this.roundsPlayed, this.firstDealer); }
  /** Call when the round is finished: adds its scores and deals the next round. */
  startNextRound() {
    if (!this.round.result || this.isFinished) return;
    for (let s = 0; s < 4; s++) this.totals[s] += this.round.result.scores[s];
    this.roundsPlayed += 1;
    if (!this.isFinished) this.round = new GameRound(dealRound(dealerForRound(this.roundsPlayed, this.firstDealer)));
  }
}

// ---------- The bot ----------

function rankDistance(a, b) {
  let d = Math.abs(a - b);
  if (a === 1) d = Math.min(d, Math.abs(14 - b));
  if (b === 1) d = Math.min(d, Math.abs(a - 14));
  return d;
}

function usefulness(card, hand) {
  if (isJoker(card)) return 100;
  let score = 0;
  for (const other of hand) {
    if (other.id === card.id || isJoker(other)) continue;
    if (other.rank === card.rank && other.suit !== card.suit) score += 2;
    if (other.suit === card.suit) {
      const d = rankDistance(card.rank, other.rank);
      if (d === 1) score += 3; else if (d === 2) score += 2;
    }
  }
  return score;
}

function chooseDiscard(round) {
  const p = round.players[round.current];
  const allowed = legalDiscards(p.hand, p.hasOpened, round.table);
  let best = null, bestU = 0;
  for (const c of allowed) {
    const u = usefulness(c, p.hand);
    if (best === null || u < bestU || (u === bestU && handPoints(c) > handPoints(best))) { best = c; bestU = u; }
  }
  return best || p.hand[0];
}

function jokerMove(round, hand) {
  for (let index = 0; index < round.table.length; index++) {
    const meld = round.table[index];
    if (!meld.cards.some(isJoker)) continue;
    if (meld.kind === 'run') {
      for (const card of hand) {
        if (!isJoker(card) && takingJoker(meld, [card])) return { type: 'takeJoker', meld: index, giving: [card] };
      }
    } else {
      const onTable = new Set(meld.cards.filter((c) => !isJoker(c)).map((c) => c.suit));
      const rank = setRank(meld);
      const candidates = [];
      for (const card of hand) {
        if (isJoker(card) || card.rank !== rank || onTable.has(card.suit)) continue;
        if (!candidates.some((c) => c.suit === card.suit)) candidates.push(card);
      }
      for (let size = Math.min(3, candidates.length); size >= 1; size--) {
        const giving = candidates.slice(0, size);
        if (takingJoker(meld, giving)) return { type: 'takeJoker', meld: index, giving };
      }
    }
  }
  return null;
}

function sellMove(round, hand) {
  if (hand.length <= 1) return null;
  const ordered = hand.filter((c) => !isJoker(c)).concat(hand.filter(isJoker));
  for (const card of ordered)
    for (let index = 0; index < round.table.length; index++)
      if (adding(round.table[index], card) !== null) return { type: 'sell', card, meld: index, atHighEnd: true };
  return null;
}

/** The next move for the player whose turn it is, or null when the round is over. */
function botNextMove(round) {
  if (round.phase === 'finished') return null;
  const p = round.players[round.current];
  const hand = p.hand;
  if (round.phase === 'firstDiscard') return { type: 'discard', card: chooseDiscard(round) };

  if (round.phase === 'draw') {
    const top = round.discardPile[round.discardPile.length - 1];
    if (top) {
      if (!p.hasOpened) {
        const plan = bestOpening(hand.concat([top]), top);
        if (plan && plan.canOpen) return { type: 'takeDiscardAndOpen', groups: plan.melds.map((m) => m.cards) };
      } else if (isSellable(top, round.table) || bestOpening(hand.concat([top]), top) !== null) {
        return { type: 'takeDiscard' };
      }
    }
    if (!p.hasOpened && round.bottomCard && handCloseGroups(hand.concat([round.bottomCard])) !== null)
      return { type: 'takeBottomCard' };
    return { type: 'drawFromPile' };
  }

  // play
  if (!p.hasOpened) {
    const plan = bestOpening(hand);
    if (plan && plan.canOpen) return { type: 'layDown', groups: plan.melds.map((m) => m.cards) };
    return { type: 'discard', card: chooseDiscard(round) };
  }
  const plan = bestOpening(hand);
  if (plan && plan.points > 0) return { type: 'layDown', groups: plan.melds.map((m) => m.cards) };
  const joker = jokerMove(round, hand);
  if (joker) return joker;
  const sell = sellMove(round, hand);
  if (sell) return sell;
  return { type: 'discard', card: chooseDiscard(round) };
}

/** The simplest legal move, used if a chosen move is refused so the game never hangs. */
function botFallbackMove(round) {
  if (round.phase === 'draw') return { type: 'drawFromPile' };
  if (round.phase === 'firstDiscard' || round.phase === 'play') {
    const p = round.players[round.current];
    const allowed = legalDiscards(p.hand, p.hasOpened, round.table);
    if (allowed.length) return { type: 'discard', card: allowed[0] };
  }
  return null;
}

/** Does ONE bot move for the current player. Returns the move that was done (or null). */
function botPlayOneMove(round) {
  const move = botNextMove(round);
  if (move) {
    try { round.perform(move); return move; } catch (e) { if (!(e instanceof MoveError)) throw e; }
  }
  const fallback = botFallbackMove(round);
  if (fallback) { try { round.perform(fallback); return fallback; } catch (e) { if (!(e instanceof MoveError)) throw e; } }
  return null;
}

return {
  SUITS, OPENING_MINIMUM, TOTAL_ROUNDS, CLOSER_POINTS,
  setRandom, shuffle, isJoker, handPoints,
  makeFullDeck, dealRound,
  positionPoints, makeSet, makeRuns, bestMeld,
  meldCandidates, bestOpening, handCloseGroups,
  makeTableMeld, adding, takingJoker, isSellable, legalDiscards, runSuit, setRank,
  isNgjyre, closeType, roundScores, dealerForRound,
  MoveError, GameRound, ZholMatch,
  botNextMove, botFallbackMove, botPlayOneMove,
};
}));
