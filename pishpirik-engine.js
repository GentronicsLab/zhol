(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Pish = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// ============================================================
// Pishpirik rules engine. 4 players in 2 teams: seats 0 and 2 are one team, seats 1 and 3 the other
// (partners sit across from each other). Seats go to the right, the direction of play.
// One deck of 52 cards, no jokers. Cards: { id, rank, suit }, rank 1 = ace ... 11 = jack, 12 = queen, 13 = king.
// ============================================================

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const JACK = 11;
const TARGET = 151;
const PLAYERS = 4;

let random = Math.random;
function setRandom(fn) { random = fn || Math.random; }

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}
function makeDeck() {
  const cards = [];
  let id = 0;
  for (const suit of SUITS) for (let rank = 1; rank <= 13; rank++) cards.push({ id: id++, rank, suit });
  return cards;
}
const teamOf = (seat) => seat % 2;
const isJack = (c) => c.rank === JACK;

/** Points of one taken card: Q, J, K, aces and 10s 1 each, the 10 of diamonds 2, the 2 of clubs 1. */
function cardPoints(c) {
  if (c.rank === 10) return c.suit === 'diamonds' ? 2 : 1;
  if (c.rank === 2) return c.suit === 'clubs' ? 1 : 0;
  if (c.rank === 1 || c.rank >= 11) return 1;
  return 0;
}

class MoveError extends Error {
  constructor(code) { super(code); this.code = code; }
}

let roundCounter = 0;

// ============================================================
// One round: two deals of 6 cards each
// ============================================================

class PishRound {
  constructor(dealer) {
    const deck = shuffle(makeDeck());          // index 0 = top, the end = the bottom
    this.id = ++roundCounter;
    this.dealer = dealer;
    this.firstPlayer = (dealer + 1) % PLAYERS;  // to the dealer's right: gets the first cards and plays first
    this.cutter = (dealer + PLAYERS - 1) % PLAYERS;

    // The cut: 3 bottom cards face down in the middle, then one face up on top of them.
    // A jack can't lie face up in the middle: it goes to the dealer, and the next card is tried.
    const faceDown = [deck.pop(), deck.pop(), deck.pop()];
    this.dealerCards = [];                     // face up for everyone to see; the dealer gets them in the second deal
    let up = deck.pop();
    while (isJack(up)) { this.dealerCards.push(up); up = deck.pop(); }
    // Then one more card is always turned face up for the dealer. If it is a jack, the next one too,
    // until a card that is not a jack shows.
    for (;;) {
      const c = deck.pop();
      this.dealerCards.push(c);
      if (!isJack(c)) break;
    }
    this.middle = faceDown.concat([up]);
    this.hidden = 3;                           // the first 3 cards of the middle are face down until someone takes them
    this.stock = deck;
    this.hands = [[], [], [], []];
    this.piles = [[], []];                     // the cards each team has taken
    this.pishpiriks = [[], []];                // face-up Pishpiriks of each team: { card, value }
    this.seen = [up].concat(this.dealerCards); // cards everyone has seen (the computer players remember them)
    this.lastTaker = null;
    this.dealNo = 0;
    this.current = this.firstPlayer;
    this.phase = 'play';                       // play | finished
    this.result = null;
    this.deal();
  }

  /** 3 cards to each player starting to the dealer's right, then 3 more. In the second deal the dealer
   *  also gets the face-up dealer cards, as his last cards. */
  deal() {
    this.dealNo += 1;
    const reserved = this.dealNo === 2 ? this.dealerCards.slice() : [];
    let fromStockForDealer = 6 - reserved.length;
    for (let pass = 0; pass < 2; pass++) {
      for (let step = 0; step < PLAYERS; step++) {
        const seat = (this.firstPlayer + step) % PLAYERS;
        for (let k = 0; k < 3; k++) {
          if (seat === this.dealer && this.dealNo === 2) {
            if (fromStockForDealer > 0) { this.hands[seat].push(this.stock.shift()); fromStockForDealer--; }
            else this.hands[seat].push(reserved.shift());
          } else {
            this.hands[seat].push(this.stock.shift());
          }
        }
      }
    }
    if (this.dealNo === 2) this.dealerCards = [];
    this.current = this.firstPlayer;
  }

  get topCard() { return this.middle.length ? this.middle[this.middle.length - 1] : null; }

  /** Would this card take the middle? Same rank as the top card, or a jack on any cards. */
  takes(card) {
    const top = this.topCard;
    return !!top && (card.rank === top.rank || isJack(card));
  }

  /** Play a card. Returns what happened (for messages, sounds and animations). Throws MoveError if not allowed. */
  play(seat, cardId) {
    if (this.phase !== 'play') throw new MoveError('wrongPhase');
    if (seat !== this.current) throw new MoveError('notYourTurn');
    const hand = this.hands[seat];
    const at = hand.findIndex((c) => c.id === cardId);
    if (at < 0) throw new MoveError('cardNotInHand');
    const card = hand.splice(at, 1)[0];
    this.seen.push(card);
    const team = teamOf(seat);
    const ev = { seat, team, card, took: null, revealed: null, pishpirik: 0, removed: null };
    const top = this.topCard;

    if (top && (card.rank === top.rank || isJack(card))) {
      // A single card taken with the same rank is a Pishpirik (10). A jack on a single jack is 20.
      // A jack on a single other card is just a normal take.
      if (this.middle.length === 1) {
        if (isJack(card) && isJack(top)) ev.pishpirik = 20;
        else if (card.rank === top.rank) ev.pishpirik = 10;
      }
      if (this.hidden > 0) { ev.revealed = this.middle.slice(0, this.hidden); this.seen.push(...ev.revealed); }
      ev.took = this.middle.concat([card]);
      this.piles[team].push(...ev.took);
      this.middle = [];
      this.hidden = 0;
      this.lastTaker = seat;
      if (ev.pishpirik) {
        const other = 1 - team;
        if (this.pishpiriks[other].length > 0) {
          // The other team loses its most recent face-up Pishpirik; this team doesn't add one.
          ev.removed = this.pishpiriks[other].pop();
        } else {
          this.pishpiriks[team].push({ card, value: ev.pishpirik });
        }
      }
    } else {
      this.middle.push(card);
    }

    this.current = (seat + 1) % PLAYERS;
    if (this.hands.every((h) => h.length === 0)) {
      if (this.dealNo === 1) { this.deal(); ev.newDeal = true; }
      else this.finish(ev);
    }
    return ev;
  }

  finish(ev) {
    // The cards still in the middle go to the team that took last.
    if (this.middle.length) {
      const team = this.lastTaker !== null ? teamOf(this.lastTaker) : teamOf(this.dealer);
      ev.lastCards = { team, cards: this.middle.slice() };
      this.piles[team].push(...this.middle);
      this.middle = [];
      this.hidden = 0;
    }
    const teams = [0, 1].map((t) => {
      const cards = this.piles[t].length;
      const cardPts = this.piles[t].reduce((s, c) => s + cardPoints(c), 0);
      const most = cards > 26 ? 3 : 0;             // 26-26: nobody gets the 3 points
      const pish = this.pishpiriks[t].reduce((s, p) => s + p.value, 0);
      return { cards, cardPoints: cardPts, mostCards: most, pishpiriks: this.pishpiriks[t].length, pishPoints: pish, total: cardPts + most + pish };
    });
    this.result = { teams, scores: teams.map((x) => x.total) };
    this.phase = 'finished';
    ev.roundOver = true;
  }

  clone() {
    const copy = Object.create(PishRound.prototype);
    Object.assign(copy, JSON.parse(JSON.stringify(this)));
    return copy;
  }
}

// ============================================================
// The game: rounds until a team reaches 151
// ============================================================

class PishMatch {
  constructor() {
    this.firstDealer = Math.floor(random() * PLAYERS);
    this.totals = [0, 0];
    this.roundsPlayed = 0;
    this.winner = null;                        // 0 or 1 when the game is over
    this.round = new PishRound(this.firstDealer);
  }
  get dealer() { return (this.firstDealer + this.roundsPlayed) % PLAYERS; }
  get isFinished() { return this.winner !== null; }

  /** Add the finished round's points. The first team to reach 151 wins; if both do, the higher total wins
   *  (if they are equal, another round is played). */
  addRound() {
    if (!this.round.result || this.round.counted) return;
    this.round.counted = true;
    for (let t = 0; t < 2; t++) this.totals[t] += this.round.result.scores[t];
    this.roundsPlayed += 1;
    const [a, b] = this.totals;
    if ((a >= TARGET || b >= TARGET) && a !== b) this.winner = a > b ? 0 : 1;
  }
  /** Deal the next round (call after addRound, when the game is not over). */
  nextRound() {
    if (this.isFinished) return;
    if (!this.round.counted) this.addRound();
    if (!this.isFinished) this.round = new PishRound(this.dealer);
  }
}

// ============================================================
// Computer player
// ============================================================

function remainingOfRank(round, rank, hand) {
  const seen = round.seen.filter((c) => c.rank === rank).length + hand.filter((c) => c.rank === rank).length;
  return 4 - seen;
}

/** Which card a computer player plays. */
function botChoose(round, seat) {
  const hand = round.hands[seat];
  const top = round.topCard;
  const value = (cards) => cards.reduce((s, c) => s + cardPoints(c), 0);
  const pile = round.middle;
  // 1. Take with the same rank (a Pishpirik if only one card lies there)
  if (top) {
    const same = hand.filter((c) => c.rank === top.rank && !isJack(c));
    if (same.length) return same.sort((a, b) => cardPoints(a) - cardPoints(b))[0];
    // 2. A jack: on a single jack (20 points), or when the middle is worth taking
    const jacks = hand.filter(isJack);
    if (jacks.length) {
      if (pile.length === 1 && isJack(top)) return jacks[0];
      if (value(pile) >= 2 || pile.length >= 4 || (round.hidden > 0)) return jacks[0];
      if (hand.length === 1) return jacks[0];
    }
  }
  // 3. Otherwise throw a card that is unlikely to give the other team a Pishpirik or points
  const choices = hand.filter((c) => !isJack(c));
  const pool = choices.length ? choices : hand;
  let best = null, bestScore = Infinity;
  for (const c of pool) {
    let score = cardPoints(c) * 3;                                       // keep point cards
    const left = remainingOfRank(round, c.rank, hand);                   // how many of that rank could still come
    if (pile.length === 0) score += left * 4;                            // on an empty middle: risk of a Pishpirik
    else score += left * 1.5 + value(pile);
    if (best === null || score < bestScore) { best = c; bestScore = score; }
  }
  return best;
}

return { SUITS, JACK, TARGET, PLAYERS, setRandom, makeDeck, teamOf, isJack, cardPoints, MoveError, PishRound, PishMatch, botChoose };
}));
