/**
 * ChessCheat — self-contained chess engine (Web Worker).
 *
 * No dependencies: no npm, no CDN, no external files. Works in Firefox and
 * Chrome immediately after loading the extension.
 *
 * UCI-like protocol:
 *   postMessage('uci')
 *   postMessage('position fen <fen>')
 *   postMessage('go depth <N>')
 *   postMessage('stop')
 *
 * Debug command:
 *   postMessage('perft <depth>')  ->  'perft <nodes> time <ms>'
 *
 * Responses:
 *   'info depth <d> score cp <white-relative> nodes <n> time <ms>'
 *   'bestmove <uci>'
 *   '__cc_engine_ready__'
 *   '__cc_engine_error__:<message>'
 */

(() => {
  'use strict';

  /* ==================== PIECES ==================== */

  const EMPTY = 0;
  const wP = 1, wN = 2, wB = 3, wR = 4, wQ = 5, wK = 6;
  const bP = 7, bN = 8, bB = 9, bR = 10, bQ = 11, bK = 12;

  const WHITE = 'w';
  const BLACK = 'b';

  const PIECE_FROM_CHAR = {
    P: wP, N: wN, B: wB, R: wR, Q: wQ, K: wK,
    p: bP, n: bN, b: bB, r: bR, q: bQ, k: bK
  };

  const PROMO_CHAR = { 2: 'n', 3: 'b', 4: 'r', 5: 'q' };

  /* ==================== 0x88 BOARD HELPERS ==================== */

  // sq = rank * 16 + file. rank 0 = chess rank 8, file 0 = a-file.
  function SQ(rank, file) { return rank * 16 + file; }
  function fileOf(s) { return s & 7; }
  function rankOf(s) { return s >> 4; }
  function onBoard(s) { return (s & 0x88) === 0; }

  const FILE_CHARS = 'abcdefgh';
  const RANK_CHARS = '87654321';

  function squareName(s) {
    return FILE_CHARS[fileOf(s)] + RANK_CHARS[rankOf(s)];
  }

  function parseSquare(name) {
    const f = FILE_CHARS.indexOf(name[0]);
    const r = RANK_CHARS.indexOf(name[1]);
    if (f < 0 || r < 0) return -1;
    return SQ(r, f);
  }

  const KNIGHT_OFFSETS = [-33, -31, -18, -14, 14, 18, 31, 33];
  const KING_OFFSETS = [-17, -16, -15, -1, 1, 15, 16, 17];
  const ROOK_OFFSETS = [-16, -1, 1, 16];
  const BISHOP_OFFSETS = [-17, -15, 15, 17];

  /* ==================== EVALUATION TABLES ==================== */

  const PIECE_VALUE = { 1: 100, 2: 320, 3: 330, 4: 500, 5: 900, 6: 0 };

  // Indexed from White's perspective: row 0 = rank 8, row 7 = rank 1.
  const PST_PAWN = [
    0, 0, 0, 0, 0, 0, 0, 0,
    78, 78, 78, 78, 78, 78, 78, 78,
    18, 18, 26, 35, 35, 26, 18, 18,
    14, 14, 28, 44, 44, 28, 14, 14,
    10, 10, 25, 40, 40, 25, 10, 10,
    5, 5, 20, 35, 35, 20, 5, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0
  ];

  const PST_KNIGHT = [
    -66, -53, -28, -28, -28, -28, -53, -66,
    -28, -10, 0, 0, 0, 0, -10, -28,
    -28, 0, 20, 25, 25, 20, 0, -28,
    -28, 5, 25, 40, 40, 25, 5, -28,
    -28, 10, 30, 40, 40, 30, 10, -28,
    -28, 10, 20, 30, 30, 20, 10, -28,
    -28, -10, 0, 0, 0, 0, -10, -28,
    -66, -53, -28, -28, -28, -28, -53, -66
  ];

  const PST_BISHOP = [
    -28, -10, -10, -10, -10, -10, -10, -28,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -28, -10, -10, -10, -10, -10, -10, -28
  ];

  const PST_ROOK = [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0
  ];

  const PST_QUEEN = [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20
  ];

  const PST_KING_MID = [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20
  ];

  const PST = {
    1: PST_PAWN,
    2: PST_KNIGHT,
    3: PST_BISHOP,
    4: PST_ROOK,
    5: PST_QUEEN,
    6: PST_KING_MID
  };

  function pieceType(piece) {
    return piece > 6 ? piece - 6 : piece;
  }

  function isWhitePiece(p) { return p >= wP && p <= wK; }
  function isBlackPiece(p) { return p >= bP && p <= bK; }

  /* ==================== BOARD ==================== */

  class Board {
    constructor() {
      this.squares = new Array(128).fill(EMPTY);
      this.side = WHITE;
      this.castling = 0; // 1=K, 2=Q, 4=k, 8=q
      this.ep = -1;
      this.halfmove = 0;
      this.fullmove = 1;
      this.kings = { w: -1, b: -1 };
    }

    static fromFen(fen) {
      const parts = String(fen).trim().split(/\s+/);
      if (parts.length < 2) throw new Error('invalid FEN');

      const b = new Board();
      const rows = parts[0].split('/');
      if (rows.length !== 8) throw new Error('invalid FEN placement');

      for (let r = 0; r < 8; r++) {
        let f = 0;
        for (const ch of rows[r]) {
          if (ch >= '1' && ch <= '8') {
            f += ch.charCodeAt(0) - 48;
          } else {
            const piece = PIECE_FROM_CHAR[ch];
            if (!piece) throw new Error('invalid piece: ' + ch);
            if (f > 7) throw new Error('rank overflow in FEN');
            const s = SQ(r, f);
            b.squares[s] = piece;
            if (piece === wK) b.kings.w = s;
            if (piece === bK) b.kings.b = s;
            f++;
          }
        }
        if (f !== 8) throw new Error('invalid rank length in FEN');
      }

      b.side = parts[1] === 'b' ? BLACK : WHITE;

      const cast = parts[2] || '-';
      b.castling = 0;
      if (cast.indexOf('K') >= 0) b.castling |= 1;
      if (cast.indexOf('Q') >= 0) b.castling |= 2;
      if (cast.indexOf('k') >= 0) b.castling |= 4;
      if (cast.indexOf('q') >= 0) b.castling |= 8;

      b.ep = (parts[3] && parts[3] !== '-') ? parseSquare(parts[3]) : -1;
      b.halfmove = parseInt(parts[4], 10) || 0;
      b.fullmove = parseInt(parts[5], 10) || 1;
      return b;
    }

    clone() {
      const b = new Board();
      b.squares = this.squares.slice();
      b.side = this.side;
      b.castling = this.castling;
      b.ep = this.ep;
      b.halfmove = this.halfmove;
      b.fullmove = this.fullmove;
      b.kings = { w: this.kings.w, b: this.kings.b };
      return b;
    }

    inCheck(side) {
      const king = this.kings[side];
      if (king < 0) return false;
      return this.isAttacked(king, side === WHITE ? BLACK : WHITE);
    }

    // Is square `target` attacked by side `bySide`?
    isAttacked(target, bySide) {
      if (target < 0 || !onBoard(target)) return false;
      const sq = this.squares;

      if (bySide === WHITE) {
        // White pawns attack "up" (toward rank 8): a white pawn attacking
        // `target` stands on target+15 or target+17.
        let t = target + 15;
        if (onBoard(t) && sq[t] === wP) return true;
        t = target + 17;
        if (onBoard(t) && sq[t] === wP) return true;

        for (let i = 0; i < KNIGHT_OFFSETS.length; i++) {
          t = target + KNIGHT_OFFSETS[i];
          if (onBoard(t) && sq[t] === wN) return true;
        }

        for (let i = 0; i < KING_OFFSETS.length; i++) {
          t = target + KING_OFFSETS[i];
          if (onBoard(t) && sq[t] === wK) return true;
        }

        for (let i = 0; i < BISHOP_OFFSETS.length; i++) {
          const off = BISHOP_OFFSETS[i];
          t = target + off;
          while (onBoard(t)) {
            const p = sq[t];
            if (p !== EMPTY) {
              if (p === wB || p === wQ) return true;
              break;
            }
            t += off;
          }
        }

        for (let i = 0; i < ROOK_OFFSETS.length; i++) {
          const off = ROOK_OFFSETS[i];
          t = target + off;
          while (onBoard(t)) {
            const p = sq[t];
            if (p !== EMPTY) {
              if (p === wR || p === wQ) return true;
              break;
            }
            t += off;
          }
        }
      } else {
        // Black pawns attack "down" (toward rank 1): a black pawn attacking
        // `target` stands on target-15 or target-17.
        let t = target - 15;
        if (onBoard(t) && sq[t] === bP) return true;
        t = target - 17;
        if (onBoard(t) && sq[t] === bP) return true;

        for (let i = 0; i < KNIGHT_OFFSETS.length; i++) {
          t = target + KNIGHT_OFFSETS[i];
          if (onBoard(t) && sq[t] === bN) return true;
        }

        for (let i = 0; i < KING_OFFSETS.length; i++) {
          t = target + KING_OFFSETS[i];
          if (onBoard(t) && sq[t] === bK) return true;
        }

        for (let i = 0; i < BISHOP_OFFSETS.length; i++) {
          const off = BISHOP_OFFSETS[i];
          t = target + off;
          while (onBoard(t)) {
            const p = sq[t];
            if (p !== EMPTY) {
              if (p === bB || p === bQ) return true;
              break;
            }
            t += off;
          }
        }

        for (let i = 0; i < ROOK_OFFSETS.length; i++) {
          const off = ROOK_OFFSETS[i];
          t = target + off;
          while (onBoard(t)) {
            const p = sq[t];
            if (p !== EMPTY) {
              if (p === bR || p === bQ) return true;
              break;
            }
            t += off;
          }
        }
      }

      return false;
    }
  }

  /* ==================== MOVE GENERATION ==================== */

  function makeMoveObject(from, to, extra) {
    const m = { from: from, to: to };
    if (extra) {
      if (extra.promo) m.promo = extra.promo;
      if (extra.ep) m.ep = true;
      if (extra.double) m.double = true;
      if (extra.castle) m.castle = extra.castle;
    }
    return m;
  }

  function addPromotions(moves, from, to, white) {
    moves.push(makeMoveObject(from, to, { promo: white ? wQ : bQ }));
    moves.push(makeMoveObject(from, to, { promo: white ? wR : bR }));
    moves.push(makeMoveObject(from, to, { promo: white ? wB : bB }));
    moves.push(makeMoveObject(from, to, { promo: white ? wN : bN }));
  }

  function generatePseudoMoves(board) {
    const moves = [];
    const side = board.side;
    const white = side === WHITE;
    const them = white ? BLACK : WHITE;
    const sq = board.squares;

    for (let s = 0; s < 128; s++) {
      if ((s & 0x88) !== 0) continue;
      const piece = sq[s];
      if (piece === EMPTY) continue;
      if (white ? !isWhitePiece(piece) : !isBlackPiece(piece)) continue;

      const type = pieceType(piece);

      if (type === 1) {
        // Pawn
        const dir = white ? -16 : 16;
        const startRank = white ? 6 : 1;
        const promoRank = white ? 0 : 7;

        const one = s + dir;
        if (onBoard(one) && sq[one] === EMPTY) {
          if (rankOf(one) === promoRank) {
            addPromotions(moves, s, one, white);
          } else {
            moves.push(makeMoveObject(s, one));
            const two = s + dir * 2;
            if (rankOf(s) === startRank && onBoard(two) && sq[two] === EMPTY) {
              moves.push(makeMoveObject(s, two, { double: true }));
            }
          }
        }

        for (let df = -1; df <= 1; df += 2) {
          const t = s + dir + df;
          if (!onBoard(t)) continue;
          const cap = sq[t];
          if (cap !== EMPTY) {
            if (white ? isBlackPiece(cap) : isWhitePiece(cap)) {
              if (rankOf(t) === promoRank) addPromotions(moves, s, t, white);
              else moves.push(makeMoveObject(s, t));
            }
          } else if (t === board.ep) {
            moves.push(makeMoveObject(s, t, { ep: true }));
          }
        }
      } else if (type === 2) {
        // Knight
        for (let i = 0; i < KNIGHT_OFFSETS.length; i++) {
          const t = s + KNIGHT_OFFSETS[i];
          if (!onBoard(t)) continue;
          const p = sq[t];
          if (p === EMPTY || (white ? isBlackPiece(p) : isWhitePiece(p))) {
            moves.push(makeMoveObject(s, t));
          }
        }
      } else if (type === 6) {
        // King
        for (let i = 0; i < KING_OFFSETS.length; i++) {
          const t = s + KING_OFFSETS[i];
          if (!onBoard(t)) continue;
          const p = sq[t];
          if (p === EMPTY || (white ? isBlackPiece(p) : isWhitePiece(p))) {
            moves.push(makeMoveObject(s, t));
          }
        }

        const homeRank = white ? 7 : 0;
        if (s === SQ(homeRank, 4) && !board.isAttacked(s, them)) {
          const kingSideRight = board.castling & (white ? 1 : 4);
          const queenSideRight = board.castling & (white ? 2 : 8);
          const rook = white ? wR : bR;

          if (kingSideRight) {
            const f1 = SQ(homeRank, 5);
            const g1 = SQ(homeRank, 6);
            const h1 = SQ(homeRank, 7);
            if (sq[f1] === EMPTY && sq[g1] === EMPTY && sq[h1] === rook &&
                !board.isAttacked(f1, them) && !board.isAttacked(g1, them)) {
              moves.push(makeMoveObject(s, g1, { castle: 'k' }));
            }
          }

          if (queenSideRight) {
            const d1 = SQ(homeRank, 3);
            const c1 = SQ(homeRank, 2);
            const b1 = SQ(homeRank, 1);
            const a1 = SQ(homeRank, 0);
            if (sq[d1] === EMPTY && sq[c1] === EMPTY && sq[b1] === EMPTY &&
                sq[a1] === rook &&
                !board.isAttacked(d1, them) && !board.isAttacked(c1, them)) {
              moves.push(makeMoveObject(s, c1, { castle: 'q' }));
            }
          }
        }
      } else {
        // Bishop, rook, queen
        const offsets = type === 3 ? BISHOP_OFFSETS
          : type === 4 ? ROOK_OFFSETS
            : KING_OFFSETS; // queen uses all eight directions

        for (let i = 0; i < offsets.length; i++) {
          const off = offsets[i];
          let t = s + off;
          while (onBoard(t)) {
            const p = sq[t];
            if (p === EMPTY) {
              moves.push(makeMoveObject(s, t));
            } else {
              if (white ? isBlackPiece(p) : isWhitePiece(p)) {
                moves.push(makeMoveObject(s, t));
              }
              break;
            }
            t += off;
          }
        }
      }
    }

    return moves;
  }

  /* ==================== MAKE MOVE ==================== */

  function makeMove(board, move) {
    const b = board.clone();
    const us = board.side;
    const them = us === WHITE ? BLACK : WHITE;
    const white = us === WHITE;
    const piece = b.squares[move.from];
    const captured = b.squares[move.to];

    b.squares[move.from] = EMPTY;

    if (move.castle === 'k') {
      const r = rankOf(move.from);
      b.squares[move.to] = piece;
      b.squares[SQ(r, 7)] = EMPTY;
      b.squares[SQ(r, 5)] = white ? wR : bR;
      b.kings[us] = move.to;
    } else if (move.castle === 'q') {
      const r = rankOf(move.from);
      b.squares[move.to] = piece;
      b.squares[SQ(r, 0)] = EMPTY;
      b.squares[SQ(r, 3)] = white ? wR : bR;
      b.kings[us] = move.to;
    } else {
      b.squares[move.to] = move.promo ? move.promo : piece;

      if (move.ep) {
        const capturedPawn = move.to + (white ? 16 : -16);
        b.squares[capturedPawn] = EMPTY;
      }

      if (piece === wK) b.kings.w = move.to;
      if (piece === bK) b.kings.b = move.to;
    }

    // Castling rights: a king move clears both rights for that side; any
    // move from/to a rook's home square clears the corresponding right.
    if (piece === wK) b.castling &= ~3;
    if (piece === bK) b.castling &= ~12;
    if (move.from === SQ(7, 0) || move.to === SQ(7, 0)) b.castling &= ~2;
    if (move.from === SQ(7, 7) || move.to === SQ(7, 7)) b.castling &= ~1;
    if (move.from === SQ(0, 0) || move.to === SQ(0, 0)) b.castling &= ~8;
    if (move.from === SQ(0, 7) || move.to === SQ(0, 7)) b.castling &= ~4;

    b.ep = move.double ? ((move.from + move.to) >> 1) : -1;
    b.halfmove = (pieceType(piece) === 1 || captured !== EMPTY || move.ep)
      ? 0 : b.halfmove + 1;
    b.side = them;
    if (!white) b.fullmove++;

    return b;
  }

  function isLegalMove(board, move) {
    const us = board.side;
    const child = makeMove(board, move);
    return !child.isAttacked(child.kings[us], child.side);
  }

  function generateLegalMoves(board) {
    const pseudo = generatePseudoMoves(board);
    const legal = [];
    for (let i = 0; i < pseudo.length; i++) {
      if (isLegalMove(board, pseudo[i])) legal.push(pseudo[i]);
    }
    return legal;
  }

  /* ==================== EVALUATION ==================== */

  function evaluate(board) {
    let score = 0; // positive = good for White
    const sq = board.squares;

    for (let s = 0; s < 128; s++) {
      if ((s & 0x88) !== 0) continue;
      const piece = sq[s];
      if (piece === EMPTY) continue;

      const white = isWhitePiece(piece);
      const type = pieceType(piece);
      const rank = rankOf(s);
      const idx = white
        ? rank * 8 + fileOf(s)
        : (7 - rank) * 8 + fileOf(s);

      const value = PIECE_VALUE[type] + PST[type][idx];
      score += white ? value : -value;
    }

    return board.side === WHITE ? score : -score;
  }

  /* ==================== SEARCH ==================== */

  const MATE = 30000;
  const SEARCH_TIMEOUT_MS = 2500;
  const DEFAULT_DEPTH = 4;

  let nodes = 0;
  let deadline = 0;
  let aborted = false;

  function moveOrderScore(board, move) {
    let score = 0;
    const piece = board.squares[move.from];

    if (move.promo) {
      score += 10000 + PIECE_VALUE[pieceType(move.promo)];
    }

    const captured = board.squares[move.to];
    if (captured !== EMPTY) {
      score += 1000 + PIECE_VALUE[pieceType(captured)] * 10 - PIECE_VALUE[pieceType(piece)];
    }

    if (move.ep) score += 1000;
    if (move.castle) score += 50;
    return score;
  }

  function negamax(board, depth, alpha, beta, ply) {
    nodes++;
    if ((nodes & 511) === 0 && Date.now() >= deadline) aborted = true;
    if (aborted) return 0;
    if (depth <= 0) return evaluate(board);

    const us = board.side;
    const them = us === WHITE ? BLACK : WHITE;
    const pseudo = generatePseudoMoves(board);

    for (let i = 0; i < pseudo.length; i++) {
      pseudo[i]._order = moveOrderScore(board, pseudo[i]);
    }
    pseudo.sort((a, b) => b._order - a._order);

    let best = -Infinity;
    let legalCount = 0;

    for (let i = 0; i < pseudo.length; i++) {
      const move = pseudo[i];
      const child = makeMove(board, move);
      if (child.isAttacked(child.kings[us], them)) continue;

      legalCount++;
      const value = -negamax(child, depth - 1, -beta, -alpha, ply + 1);
      if (aborted) return 0;

      if (value > best) best = value;
      if (value > alpha) alpha = value;
      if (alpha >= beta) break;
    }

    if (legalCount === 0) {
      return board.isAttacked(board.kings[us], them) ? -MATE + ply : 0;
    }

    return best;
  }

  function searchBestMove(board, maxDepth) {
    nodes = 0;
    aborted = false;
    deadline = Date.now() + SEARCH_TIMEOUT_MS;
    const startedAt = Date.now();
    const us = board.side;

    const rootMoves = generateLegalMoves(board);
    if (rootMoves.length === 0) return null;

    let bestMove = rootMoves[0];
    let bestScore = 0;

    for (let depth = 1; depth <= maxDepth; depth++) {
      if (bestMove) {
        const idx = rootMoves.indexOf(bestMove);
        if (idx > 0) {
          rootMoves.splice(idx, 1);
          rootMoves.unshift(bestMove);
        }
      }

      let alpha = -Infinity;
      let currentBest = rootMoves[0];
      let currentScore = -Infinity;

      for (let i = 0; i < rootMoves.length; i++) {
        const move = rootMoves[i];
        const child = makeMove(board, move);
        const value = -negamax(child, depth - 1, -Infinity, -alpha, 1);
        if (aborted) break;

        if (value > currentScore) {
          currentScore = value;
          currentBest = move;
        }
        if (value > alpha) alpha = value;
      }

      if (aborted) break;

      bestMove = currentBest;
      bestScore = currentScore;

      const whiteScore = us === WHITE ? bestScore : -bestScore;
      postMessage(
        'info depth ' + depth +
        ' score cp ' + whiteScore +
        ' nodes ' + nodes +
        ' time ' + (Date.now() - startedAt)
      );
    }

    return bestMove;
  }

  function moveToUci(move) {
    let out = squareName(move.from) + squareName(move.to);
    if (move.promo) out += PROMO_CHAR[pieceType(move.promo)];
    return out;
  }

  /* ==================== PERFT (debug) ==================== */

  function perft(board, depth) {
    if (depth <= 0) return 1;
    const moves = generateLegalMoves(board);
    if (depth === 1) return moves.length;

    let total = 0;
    for (let i = 0; i < moves.length; i++) {
      total += perft(makeMove(board, moves[i]), depth - 1);
    }
    return total;
  }

  /* ==================== WORKER PROTOCOL ==================== */

  let currentBoard = null;

  function postError(message) {
    try {
      self.postMessage('__cc_engine_error__:' + String(message));
    } catch (e) { /* ignore */ }
  }

  function postReady() {
    try {
      self.postMessage('__cc_engine_ready__');
    } catch (e) { /* ignore */ }
  }

  function handleCommand(raw) {
    const cmd = typeof raw === 'string' ? raw.trim() : '';
    if (!cmd) return;

    if (cmd === 'uci') {
      postMessage('id name ChessCheat Engine');
      postMessage('id author sackedrai');
      postMessage('uciok');
      return;
    }

    if (cmd === 'isready') {
      postMessage('readyok');
      return;
    }

    if (cmd.indexOf('position fen ') === 0) {
      const fen = cmd.substring('position fen '.length).trim();
      currentBoard = Board.fromFen(fen);
      return;
    }

    if (cmd.indexOf('position startpos') === 0) {
      currentBoard = Board.fromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
      return;
    }

    if (cmd.indexOf('go') === 0) {
      const parts = cmd.split(/\s+/);
      let depth = DEFAULT_DEPTH;
      const depthIndex = parts.indexOf('depth');
      if (depthIndex >= 0) {
        const parsed = parseInt(parts[depthIndex + 1], 10);
        if (parsed > 0) depth = Math.min(parsed, 32);
      }

      if (!currentBoard) {
        postError('no position set');
        postMessage('bestmove (none)');
        return;
      }

      let best = null;
      try {
        best = searchBestMove(currentBoard, depth);
      } catch (e) {
        postError('search failed: ' + ((e && e.message) ? e.message : String(e)));
      }

      if (!best) {
        const legal = generateLegalMoves(currentBoard);
        best = legal.length > 0 ? legal[0] : null;
      }

      postMessage('bestmove ' + (best ? moveToUci(best) : '(none)'));
      return;
    }

    if (cmd.indexOf('perft ') === 0) {
      const depth = parseInt(cmd.substring(6), 10) || 1;
      if (!currentBoard) {
        postError('no position set');
        return;
      }
      const startedAt = Date.now();
      const total = perft(currentBoard, depth);
      postMessage('perft ' + total + ' time ' + (Date.now() - startedAt));
      return;
    }

    if (cmd === 'stop' || cmd === 'quit') {
      aborted = true;
      return;
    }
  }

  self.onmessage = (event) => {
    try {
      handleCommand(event.data);
    } catch (e) {
      postError((e && e.message) ? e.message : String(e));
    }
  };

  postReady();
})();
