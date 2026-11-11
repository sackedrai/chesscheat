(() => {
  'use strict';

  // Защита от повторной инициализации
  if (window.__chessCheatInit) {
    console.log('[ChessCheat] already init');
    return;
  }
  window.__chessCheatInit = true;

  console.log('[ChessCheat] loaded', location.href);

  // ==================== КОНФИГ ====================
  const CONFIG = {
    minDepth: 2,
    maxDepth: 6,
    defaultDepth: 4,
    analyzeDebounceMs: 300,
    overlayPollMs: 600,
    urlPollMs: 1500,
    maxCp: 400,
    mateCp: 10000,
    searchTimeoutMs: 3000,
    engineTimeoutMs: 8000
  };

  const CHAR_MAP = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 };
  const PIECE_RE = /^[wb][prnbqk]$/;

  const THEMES = {
    dark:     { bg: '#262421', header: '#1e1e1c', border: '#3a3937', card: '#1a1a18', text: '#eee', sub: '#9e9e9e' },
    light:    { bg: '#f5f5f0', header: '#e8e8e6', border: '#d8d5d0', card: '#ffffff', text: '#1a1a1a', sub: '#6b6b6b' },
    midnight: { bg: '#0d1117', header: '#010409', border: '#30363d', card: '#161b22', text: '#c9d1d9', sub: '#8b949e' },
    forest:   { bg: '#1b2a1b', header: '#142014', border: '#2a3d2a', card: '#1e331e', text: '#d4e4d4', sub: '#8aa88a' },
    ocean:    { bg: '#0f1e2e', header: '#0a1628', border: '#1e3a5f', card: '#132a45', text: '#c8d8e8', sub: '#7a9ab8' },
    amoled:   { bg: '#000000', header: '#0a0a0a', border: '#222', card: '#111', text: '#eee', sub: '#888' }
  };

  const DEFAULTS = {
    depth: 4, showHighlights: true,
    theme: 'dark', accent: '#81b64c', opacity: 100, overlayWidth: 300, fontScale: 100,
    blur: true, compact: false,
    hlFrom: '#81b64c', hlFromOpacity: 55, hlTo: '#f7c948', hlToOpacity: 65
  };

  // ==================== STATE ====================
  let hackRunning = false;
  let globalDepth = DEFAULTS.depth;
  let showHighlights = DEFAULTS.showHighlights;
  let calculating = false;
  let engineWorker = null;
  let engineWorkerUrl = null;
  let engineReady = false;
  let engineError = false;
  let engineWatchdog = null;

  let observer = null;
  let debounceTimer = null;
  let lastFen = '';
  let lastBestMove = null;
  let lastEvalCp = 0;
  let lastMate = null;

  let overlayEl = null;
  let isMinimized = false;

  let currentTheme = DEFAULTS.theme;
  let accentColor = DEFAULTS.accent;
  let opacity = DEFAULTS.opacity;
  let overlayWidth = DEFAULTS.overlayWidth;
  let fontScale = DEFAULTS.fontScale;
  let blurEnabled = DEFAULTS.blur;
  let compactMode = DEFAULTS.compact;
  let hlFrom = DEFAULTS.hlFrom;
  let hlTo = DEFAULTS.hlTo;
  let hlFromOpacity = DEFAULTS.hlFromOpacity;
  let hlToOpacity = DEFAULTS.hlToOpacity;

  let hideOpponentMoves = true;

  let highlightA = null;
  let highlightB = null;

  // ==================== POSITION TRACKER (корректный FEN) ====================
  class PositionTracker {
    constructor() {
      this.reset();
    }

    reset() {
      this.plies = 0;
      this.lastMoveUci = null;
      this.board = Array.from({ length: 8 }, () => Array(8).fill(null));
    }

    // Обновляет расстановку фигур из DOM-элементов .piece
    setPiecesFromDOM(pieces) {
      this.board = Array.from({ length: 8 }, () => Array(8).fill(null));
      for (const el of pieces) {
        let sq = null, type = null;
        for (let j = 0; j < el.classList.length; j++) {
          const c = el.classList[j];
          if (c.indexOf('square-') === 0) sq = c;
          else if (c.length === 2 && PIECE_RE.test(c)) type = c;
        }
        if (!sq || !type) continue;
        const m = sq.match(/square-(\d)(\d)/);
        if (!m) continue;
        const file = m[1].charCodeAt(0) - 49;
        const rank = m[2].charCodeAt(0) - 49;
        if (file >= 0 && file < 8 && rank >= 0 && rank < 8) {
          this.board[rank][file] = type;
        }
      }
    }

    // Устанавливает количество полуходов (для номера хода)
    setPlies(n) {
      this.plies = Math.max(0, parseInt(n, 10) || 0);
    }

    incrementPlies() {
      this.plies++;
    }

    // Права рокировки: только если король и ладья на исходных клетках.
    // Это исправляет баг оригинала, который всегда считал все рокировки доступными.
    getCastlingRights() {
      let c = '';
      // Белые: королес на e1 (rank 0, file 4)
      if (this.board[0][4] === 'wk') {
        if (this.board[0][7] === 'wr') c += 'K';
        if (this.board[0][0] === 'wr') c += 'Q';
      }
      // Чёрные: королес на e8 (rank 7, file 4)
      if (this.board[7][4] === 'bk') {
        if (this.board[7][7] === 'br') c += 'k';
        if (this.board[7][0] === 'br') c += 'q';
      }
      return c || '-';
    }

    // En passant: упрощённо — всегда '-'.
    // Полноценный учёт требует анализа последнего хода (двойной толчок пешки),
    // что редко влияет на оценку позиции в контексте оверлея.
    getEnPassant() {
      return '-';
    }

    getHalfmove() {
      return '0';
    }

    getFullmove() {
      return Math.floor(this.plies / 2) + 1;
    }

    getPlacement() {
      let fen = '';
      for (let r = 7; r >= 0; r--) {
        let empty = 0;
        for (let f = 0; f < 8; f++) {
          const p = this.board[r][f];
          if (!p) {
            empty++;
          } else {
            if (empty) { fen += empty; empty = 0; }
            fen += p[0] === 'w' ? p[1].toUpperCase() : p[1];
          }
        }
        if (empty) fen += empty;
        if (r > 0) fen += '/';
      }
      return fen;
    }

    // Собирает полный FEN
    getFen(activeColor) {
      const placement = this.getPlacement();
      const castling = this.getCastlingRights();
      const ep = this.getEnPassant();
      const halfmove = this.getHalfmove();
      const fullmove = this.getFullmove();
      return `${placement} ${activeColor} ${castling} ${ep} ${halfmove} ${fullmove}`;
    }
  }

  const positionTracker = new PositionTracker();

  // ==================== УТИЛИТЫ ====================
  function hexToRgba(hex, alphaPct) {
    const a = Math.max(0, Math.min(100, alphaPct)) / 100;
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  function hexToRgbaAlpha(hex, alpha01) {
    const a = Math.max(0, Math.min(1, alpha01));
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get(keys, resolve);
        } else {
          const out = {};
          for (const k in keys) {
            const v = localStorage.getItem(k);
            out[k] = v != null ? JSON.parse(v) : keys[k];
          }
          resolve(out);
        }
      } catch (e) { resolve(keys); }
    });
  }
  function storageSet(obj) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set(obj, resolve);
        } else {
          for (const k in obj) localStorage.setItem(k, JSON.stringify(obj[k]));
          resolve();
        }
      } catch (e) { resolve(); }
    });
  }

  function log(msg) {
    try { console.log('[ChessCheat]', msg); } catch (e) {}
  }
  function warn(msg) {
    try { console.warn('[ChessCheat]', msg); } catch (e) {}
  }
  function error(msg) {
    try { console.error('[ChessCheat]', msg); } catch (e) {}
  }

  // ==================== ДВИЖОК (локальный ChessCheat Engine) ====================
  async function createEngineWorker() {
    if (engineWorker) {
      try { engineWorker.terminate(); } catch (e) {}
      engineWorker = null;
    }
    engineReady = false;
    engineError = false;

    // Загружаем воркер через fetch + Blob URL — работает в Firefox лучше,
    // чем chrome.runtime.getURL для temporary extensions.
    let workerUrl;
    try {
      const workerFileUrl = chrome.runtime.getURL('scripts/stockfish-worker.js');
      let response;
      try {
        response = await fetch(workerFileUrl, { cache: 'no-store' });
      } catch (e) {
        response = await fetch(workerFileUrl);
      }
      if (!response.ok) throw new Error('worker fetch failed: ' + response.status);
      const text = await response.text();
      if (!text || text.length < 100) throw new Error('worker file is empty');
      const blob = new Blob([text], { type: 'application/javascript' });
      workerUrl = URL.createObjectURL(blob);
      engineWorkerUrl = workerUrl;
    } catch (e) {
      error('worker fetch failed, using direct URL', e);
      try { workerUrl = chrome.runtime.getURL('scripts/stockfish-worker.js'); }
      catch (e2) { workerUrl = 'scripts/stockfish-worker.js'; }
    }

    try {
      engineWorker = new Worker(workerUrl);
    } catch (e) {
      error('Worker creation failed', e);
      engineError = true;
      throw e;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const onReady = () => {
        if (settled) return;
        settled = true;
        engineReady = true;
        engineError = false;
        log('Engine worker ready');
        resolve(engineWorker);
      };
      const onError = (msg) => {
        error(msg);
        clearEngineWatchdog();
        engineError = true;
        engineReady = false;
        calculating = false;
        if (!settled) {
          settled = true;
          reject(new Error(msg));
        } else {
          applyOverlayState();
        }
      };

      engineWorker.onmessage = (event) => {
        const data = typeof event.data === 'string' ? event.data : String(event.data);

        if (data === '__cc_engine_ready__') {
          onReady();
          if (hackRunning) scheduleAnalyze();
          return;
        }
        if (data === '__cc_engine_stopped__') {
          engineReady = false;
          return;
        }
        if (data.indexOf('__cc_engine_error__:') === 0) {
          onError(data.substring('__cc_engine_error__:'.length));
          return;
        }

        if (data.indexOf('info ') === 0) {
          updateEvalFromInfo(data);
          calculating = true;
          applyOverlayState();
        } else if (data.indexOf('bestmove') === 0) {
          calculating = false;
          clearEngineWatchdog();
          const parts = data.split(' ');
          const bestMove = parts[1];
          if (!bestMove || bestMove === '(none)') {
            applyOverlayState();
            return;
          }
          lastBestMove = bestMove;
          try { renderBestMove(bestMove); applyOverlayState(); } catch (e) {}
        }
      };

      engineWorker.onerror = (e) => {
        error('Engine worker error', e);
        onError('Engine worker error: ' + (e.message || String(e)));
      };

      // Таймаут на случай, если готовость не пришла
      setTimeout(() => {
        if (!settled) {
          settled = true;
          engineReady = true;
          resolve(engineWorker);
        }
      }, 1000);
    });
  }

  function clearEngineWatchdog() {
    if (engineWatchdog) {
      clearTimeout(engineWatchdog);
      engineWatchdog = null;
    }
  }

  function armEngineWatchdog() {
    clearEngineWatchdog();
    engineWatchdog = setTimeout(() => {
      engineWatchdog = null;
      if (!calculating) return;
      error('Engine watchdog: no bestmove received');
      terminateEngine();
      engineError = true;
      calculating = false;
      applyOverlayState();
    }, CONFIG.engineTimeoutMs);
  }

  function terminateEngine() {
    clearEngineWatchdog();
    if (engineWorker) {
      try { engineWorker.postMessage('stop'); } catch (e) {}
      try { engineWorker.terminate(); } catch (e) {}
      engineWorker = null;
    }
    if (engineWorkerUrl) {
      try { URL.revokeObjectURL(engineWorkerUrl); } catch (e) {}
      engineWorkerUrl = null;
    }
    engineReady = false;
    engineError = false;
  }

  // ==================== FEN И ХОДЫ ====================
  function getFenPlacement() {
    const pieces = document.querySelectorAll('.piece');
    if (!pieces.length) return null;
    positionTracker.setPiecesFromDOM(pieces);
    return { placement: positionTracker.getPlacement(), board: positionTracker.board };
  }

  function detectActiveColor() {
    const clockSels = [
      '.clock-component--active',
      '.clock-component.clock--active',
      '.clock--active',
      '[class*="clock--active"]',
      '.clock-player-turn'
    ];
    for (let i = 0; i < clockSels.length; i++) {
      const activeClock = document.querySelector(clockSels[i]);
      if (activeClock) {
        let isBottomActive = false;
        const bottomSels = [
          '.clock-bottom',
          '.board-layout-player-bottom .clock-component',
          '.clock-component.clock-bottom'
        ];
        for (let k = 0; k < bottomSels.length; k++) {
          const bottom = document.querySelector(bottomSels[k]);
          if (bottom && (activeClock === bottom || bottom.contains(activeClock) ||
              (activeClock.closest && activeClock.closest(bottomSels[k])))) {
            isBottomActive = true;
            break;
          }
        }
        if (!isBottomActive) {
          const allClocks = [].slice.call(
            document.querySelectorAll('.clock-component, [class*="clock"]')
          ).filter((c) => c.offsetParent);
          if (allClocks.length >= 2) {
            const activeRect = activeClock.getBoundingClientRect();
            let maxTop = allClocks[0].getBoundingClientRect().top;
            for (let t = 1; t < allClocks.length; t++) {
              const r = allClocks[t].getBoundingClientRect();
              if (r.top > maxTop) maxTop = r.top;
            }
            isBottomActive = Math.abs(activeRect.top - maxTop) < 5;
          }
        }
        const board = document.querySelector('wc-chess-board');
        const playerColor = board && board.classList.contains('flipped') ? 'b' : 'w';
        const res = isBottomActive ? playerColor : (playerColor === 'w' ? 'b' : 'w');
        try { log('detect via clock', clockSels[i], res); } catch (e) {}
        return res;
      }
    }

    const plyNodes = document.querySelectorAll('.vertical-move-list [data-ply], #move-list [data-ply], wc-move');
    if (plyNodes.length) {
      positionTracker.setPlies(plyNodes.length);
      return plyNodes.length % 2 === 0 ? 'w' : 'b';
    }
    const moveList = document.querySelector('.vertical-move-list, #move-list');
    if (moveList) {
      const whitePly = document.querySelectorAll('.move .white-move, .node.white');
      const blackPly = document.querySelectorAll('.move .black-move, .node.black');
      if (whitePly.length || blackPly.length) {
        const total = whitePly.length + blackPly.length;
        positionTracker.setPlies(total);
        return total % 2 === 0 ? 'w' : 'b';
      }
      if (!moveList.textContent.trim()) return 'w';
    }
    return 'w';
  }

  function getTurnInfo() {
    const board = document.querySelector('wc-chess-board');
    const playerColor = board && board.classList.contains('flipped') ? 'b' : 'w';
    const activeColor = detectActiveColor();
    const isMy = activeColor === playerColor;
    return {
      playerColor,
      activeColor,
      isMyTurn: isMy,
      playerName: playerColor === 'w' ? 'Белые (ты)' : 'Чёрные (ты)',
      activeName: activeColor === 'w' ? 'Белые' : 'Чёрные'
    };
  }
  function isMyTurn() {
    try { return getTurnInfo().isMyTurn; } catch (e) { return true; }
  }
  function isGameOver() {
    return !!document.querySelector('.game-over, .game-result, .board-modal-container, [class*="game-over"]');
  }

  function getFullFen() {
    const res = getFenPlacement();
    if (!res) return null;
    const activeColor = detectActiveColor();
    positionTracker.setPlies(
      document.querySelectorAll('.vertical-move-list [data-ply], #move-list [data-ply], wc-move').length ||
      0
    );
    const fen = positionTracker.getFen(activeColor);
    try { log('FEN DOM', fen); } catch (e) {}
    return fen;
  }

  function findBoard() {
    const inner = document.querySelector(
      'wc-chess-board .board, chess-board .board, .board .square-11, wc-chess-board .square-11'
    );
    if (inner) {
      const boardEl = inner.closest
        ? (inner.closest('.board') || inner.closest('wc-chess-board') || inner.closest('chess-board'))
        : inner.parentElement;
      if (boardEl) return boardEl;
      return inner.parentElement || inner;
    }
    const sels = ['wc-chess-board', 'chess-board', '.board'];
    for (let i = 0; i < sels.length; i++) {
      const b = document.querySelector(sels[i]);
      if (b) return b;
    }
    const sq = document.querySelector('.square-11, [class*="square-11"]');
    if (sq) {
      let p = sq.parentElement;
      for (let i = 0; i < 6; i++) {
        if (!p) break;
        if (p.classList && p.classList.contains('board')) return p;
        p = p.parentElement;
      }
      return sq.parentElement;
    }
    return null;
  }

  // ==================== ПОДСВЕТКА ====================
  function ensureHighlights() {
    const board = findBoard();
    if (!board) {
      warn('board not found for highlight');
      return null;
    }
    if (!highlightA) {
      highlightA = document.createElement('div');
      highlightA.className = 'highlight cheat-highlight';
      highlightA.style.pointerEvents = 'none';
      highlightA.style.opacity = '1';
      highlightA.style.zIndex = '10';
      highlightA.style.background = hexToRgbaAlpha(hlFrom, hlFromOpacity / 100);
      highlightA.style.border = '2px solid ' + hlFrom;

      highlightB = document.createElement('div');
      highlightB.className = 'highlight cheat-highlight';
      highlightB.style.pointerEvents = 'none';
      highlightB.style.opacity = '1';
      highlightB.style.zIndex = '10';
      highlightB.style.background = hexToRgbaAlpha(hlTo, hlToOpacity / 100);
      highlightB.style.boxShadow = 'inset 0 0 0 2px rgba(0,0,0,0.25)';
      highlightB.style.border = '2px solid ' + hlTo;
      log('highlights created');
    } else {
      highlightA.style.background = hexToRgbaAlpha(hlFrom, hlFromOpacity / 100);
      highlightA.style.border = '2px solid ' + hlFrom;
      highlightB.style.background = hexToRgbaAlpha(hlTo, hlToOpacity / 100);
      highlightB.style.border = '2px solid ' + hlTo;
    }
    try {
      const cs = getComputedStyle(board);
      if (cs.position === 'static') board.style.position = 'relative';
    } catch (e) {}
    return board;
  }

  function renderBestMove(bestMove) {
    lastBestMove = bestMove;
    try {
      if (typeof window.__cc_hideOpponent !== 'undefined') hideOpponentMoves = !!window.__cc_hideOpponent;
    } catch (e) {}
    if (hideOpponentMoves && !isMyTurn()) {
      clearHighlights();
      log('hide opponent move', bestMove);
      return;
    }
    if (!showHighlights) {
      log('highlights disabled');
      return;
    }
    const board = ensureHighlights();
    if (!board) {
      warn('no board for render', bestMove);
      return;
    }
    if (bestMove.length < 4) {
      warn('bad move format', bestMove);
      return;
    }
    const fromFile = bestMove[0], fromRank = bestMove[1], toFile = bestMove[2], toRank = bestMove[3];
    if (!CHAR_MAP[fromFile] || !CHAR_MAP[toFile]) {
      warn('bad move format', bestMove);
      return;
    }
    const fromSq = '' + CHAR_MAP[fromFile] + fromRank;
    const toSq = '' + CHAR_MAP[toFile] + toRank;
    highlightA.className = 'highlight cheat-highlight square-' + fromSq;
    highlightB.className = 'highlight cheat-highlight square-' + toSq;
    try {
      highlightA.style.left = ''; highlightA.style.top = '';
      highlightA.style.width = ''; highlightA.style.height = '';
      highlightB.style.left = ''; highlightB.style.top = '';
      highlightB.style.width = ''; highlightB.style.height = '';
    } catch (e) {}

    let targetBoard = board;
    try {
      const inner = board.querySelector('.board');
      if (inner && inner.querySelector('.square-11')) targetBoard = inner;
      else if (board.classList.contains('board')) targetBoard = board;
    } catch (e) {}
    if (!highlightA.parentNode || highlightA.parentNode !== targetBoard) targetBoard.appendChild(highlightA);
    if (!highlightB.parentNode || highlightB.parentNode !== targetBoard) targetBoard.appendChild(highlightB);
    log('highlight shown', bestMove, 'from', fromSq, 'to', toSq);
  }

  function clearHighlights() {
    if (highlightA && highlightA.parentNode) highlightA.remove();
    if (highlightB && highlightB.parentNode) highlightB.remove();
  }

  // ==================== ОВЕРЛЕЙ (стили + DOM) ====================
  function injectStyles() {
    if (document.getElementById('chesscheat-style')) return;
    const st = document.createElement('style');
    st.id = 'chesscheat-style';
    st.textContent = `
#cc-overlay{position:fixed;top:88px;right:16px;width:300px;background:#262421;color:#eee;border:1px solid #3a3937;border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,0.55);z-index:99999;font-family:Segoe UI,Roboto,Arial,sans-serif;overflow:hidden;user-select:none}
#cc-overlay.cc-hidden{display:none}
#cc-overlay.cc-minimized #cc-body{display:none}
#cc-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#1e1e1c;cursor:move;border-bottom:1px solid #33312e}
#cc-header-left{display:flex;align-items:center;gap:8px;font-weight:800;font-size:13px}
#cc-header-left i{font-style:normal;background:#81b64c;color:#111;width:22px;height:22px;display:grid;place-items:center;border-radius:6px;font-size:12px}
#cc-header-actions{display:flex;gap:6px}
.cc-icon-btn{width:26px;height:26px;border-radius:8px;border:1px solid #3a3937;background:#2a2a28;color:#ccc;display:grid;place-items:center;cursor:pointer;font-size:13px}
#cc-body{padding:12px;display:flex;flex-direction:column;gap:10px}
.cc-status{display:flex;align-items:center;gap:8px;background:#1a1a18;border:1px solid #33312e;padding:8px 10px;border-radius:10px}
.cc-dot{width:10px;height:10px;border-radius:50%;background:#555}
.cc-dot.on{background:#81b64c;box-shadow:0 0 8px rgba(129,182,76,0.7)}
.cc-dot.calc{background:#f7c948;box-shadow:0 0 8px rgba(247,201,72,0.7);animation:ccPulse 1s infinite}
@keyframes ccPulse{0%,100%{opacity:1}50%{opacity:0.45}}
.cc-fen{font-family:monospace;font-size:9px;background:#1e1e1c;border:1px solid #2e2e2e;padding:6px 8px;border-radius:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cc-best{border-radius:12px;background:linear-gradient(135deg,rgba(0,0,0,0.15),transparent);border:1px solid #3a3937;padding:12px;display:flex;flex-direction:column;gap:8px}
.cc-best-label{font-size:10px;letter-spacing:0.8px;font-weight:700;text-transform:uppercase;opacity:0.7}
.cc-best-main{display:flex;align-items:center;justify-content:space-between;gap:8px}
.cc-best-move{font-family:monospace;font-weight:800;font-size:14px;text-align:center}
.cc-eval{display:flex;align-items:center;gap:8px}
.cc-eval-bar{flex:1;height:6px;background:#1a1a1a;border-radius:20px;overflow:hidden;border:1px solid #333}
.cc-eval-fill{height:100%;width:50%;background:linear-gradient(90deg,#ff6b6b,#f7c948,#81b64c)}
.cc-eval-text{font-family:monospace;font-size:12px;min-width:52px;text-align:right}
.cc-depth{display:flex;flex-direction:column;gap:6px}
.cc-depth-head{display:flex;justify-content:space-between;align-items:center;font-size:12px;font-weight:700}
.cc-presets{display:flex;gap:6px}
.cc-presets button{flex:1;background:#1a1a1a;border:1px solid #3a3937;color:#ccc;padding:6px 4px;border-radius:8px;font-size:11px;cursor:pointer}
.cc-presets button.active{background:#81b64c;color:#111;font-weight:800;border-color:#81b64c}
#cc-toggle{width:100%;padding:10px;border-radius:10px;border:none;font-weight:800;cursor:pointer;font-family:inherit}
`;
    document.head.appendChild(st);
  }

  function createOverlay() {
    if (document.getElementById('cc-overlay')) return;
    injectStyles();
    const el = document.createElement('div');
    el.id = 'cc-overlay';
    el.innerHTML = `
<div id="cc-header">
  <div id="cc-header-left"><i>♔</i> ChessCheat <span style="font-size:10px;background:rgba(129,182,76,0.15);color:#81b64c;padding:2px 6px;border-radius:20px;margin-left:4px">v2.3</span></div>
  <div id="cc-header-actions"><button class="cc-icon-btn" id="cc-min" title="Свернуть">—</button><button class="cc-icon-btn" id="cc-close" title="Скрыть">×</button></div>
</div>
<div id="cc-body">
  <div class="cc-status cc-card"><div class="cc-dot" id="cc-dot"></div><span class="cc-status-text" id="cc-status">Idle</span></div>
  <div class="cc-depth-badge-row" style="display:flex;justify-content:center;font-size:10px;opacity:0.6;margin-top:2px"><span id="cc-depth-badge">d${globalDepth}</span></div>
  <div class="cc-turn cc-card" id="cc-turn" style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border-radius:8px;font-size:11px;font-weight:700"><span id="cc-turn-text">—</span><span id="cc-turn-badge" style="padding:2px 8px;border-radius:20px;font-size:10px;background:#333;color:#fff">—</span></div>
  <div class="cc-fen cc-card" id="cc-fen" title="FEN">Ожидание доски…</div>
  <div class="cc-best cc-card">
    <div class="cc-best-label">Лучший ход • ChessCheat Engine</div>
    <div class="cc-best-main"><div class="cc-best-move" id="cc-bestmove" style="flex:1;text-align:center">—</div></div>
    <div class="cc-eval"><div class="cc-eval-bar"><div class="cc-eval-fill" id="cc-evalfill"></div></div><span class="cc-eval-text" id="cc-eval">0.00</span></div>
    <div id="cc-win" style="font-size:10px;font-weight:700;opacity:0.9;margin-top:4px;padding:6px 8px;background:rgba(0,0,0,0.15);border-radius:8px;border:1px solid rgba(255,255,255,0.06)">—</div>
  </div>
  <div class="cc-depth cc-card">
    <div class="cc-depth-head" style="display:flex;justify-content:space-between;align-items:center"><label style="font-size:12px;font-weight:700">Глубина</label><span id="cc-depthval">${globalDepth}</span></div>
    <input type="range" id="cc-range" min="${CONFIG.minDepth}" max="${CONFIG.maxDepth}" value="${globalDepth}" step="1">
    <div class="cc-presets"><button data-d="2">Быстро 2</button><button data-d="4" class="active">Баланс 4</button><button data-d="6">Сильно 6</button></div>
  </div>
  <div style="margin-top:8px">
    <button id="cc-toggle" style="background:${accentColor};color:#111">${hackRunning ? '■' : '▶'} ${hackRunning ? 'Остановить' : 'Запустить анализ'}</button>
    <label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px"><input type="checkbox" id="cc-hl" ${showHighlights ? 'checked' : ''}> Подсветка ходов</label>
  </div>
</div>`;
    document.body.appendChild(el);
    overlayEl = el;
    bindOverlayEvents();
    applyOverlayState();
    applyTheme();
    log('overlay created');
  }

  function bindOverlayEvents() {
    const header = document.getElementById('cc-header');
    const toggleBtn = document.getElementById('cc-toggle');
    const range = document.getElementById('cc-range');
    const hl = document.getElementById('cc-hl');
    const minBtn = document.getElementById('cc-min');
    const closeBtn = document.getElementById('cc-close');
    if (!header || !toggleBtn) {
      warn('bind fail', header, toggleBtn);
      return;
    }

    let isDragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      isDragging = true;
      const rect = overlayEl.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY; startLeft = rect.left; startTop = rect.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      let nx = startLeft + dx, ny = startTop + dy;
      nx = Math.max(4, Math.min(window.innerWidth - overlayEl.offsetWidth - 4, nx));
      ny = Math.max(4, Math.min(window.innerHeight - overlayEl.offsetHeight - 4, ny));
      overlayEl.style.left = nx + 'px';
      overlayEl.style.top = ny + 'px';
      overlayEl.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        storageSet({ overlayPos: { left: overlayEl.style.left, top: overlayEl.style.top } });
      }
    });

    let toggleLock = false;
    const onToggle = (e) => {
      if (toggleLock) return;
      toggleLock = true;
      setTimeout(() => { toggleLock = false; }, 450);
      if (e) { try { e.preventDefault(); e.stopPropagation(); } catch (e2) {} }
      log('toggle click', hackRunning);
      if (hackRunning) stopHack(); else startHack();
    };
    toggleBtn.addEventListener('click', onToggle);

    if (range) {
      range.addEventListener('input', () => {
        const v = parseInt(range.value, 10);
        setDepth(v);
      });
      document.querySelectorAll('.cc-presets button').forEach((b) => {
        b.addEventListener('click', () => {
          const v = parseInt(b.getAttribute('data-d'), 10);
          setDepth(v);
        });
      });
    }
    if (hl) {
      hl.addEventListener('change', () => {
        showHighlights = hl.checked;
        storageSet({ showHighlights });
        if (!showHighlights) clearHighlights();
        else if (lastBestMove) renderBestMove(lastBestMove);
      });
      hl.checked = showHighlights;
    }
    if (minBtn) {
      minBtn.addEventListener('click', () => {
        isMinimized = !isMinimized;
        overlayEl.classList.toggle('cc-minimized', isMinimized);
        minBtn.textContent = isMinimized ? '+' : '—';
        storageSet({ overlayMinimized: isMinimized });
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        overlayEl.classList.add('cc-hidden');
        storageSet({ overlayHidden: true });
      });
    }
    overlayEl.addEventListener('dblclick', () => clearHighlights());
  }

  function setDepth(v) {
    v = Math.max(CONFIG.minDepth, Math.min(CONFIG.maxDepth, parseInt(v, 10) || CONFIG.defaultDepth));
    globalDepth = v;
    const r = document.getElementById('cc-range');
    if (r) r.value = v;
    const dv = document.getElementById('cc-depthval');
    if (dv) dv.textContent = v;
    const bd = document.getElementById('cc-depth-badge');
    if (bd) bd.textContent = 'd' + v;
    document.querySelectorAll('.cc-presets button').forEach((b) => {
      b.classList.toggle('active', parseInt(b.getAttribute('data-d'), 10) === v);
    });
    storageSet({ depth: v });
    applyOverlayState();
    if (hackRunning) {
      lastFen = '';
      scheduleAnalyze();
    }
  }

  // ==================== ТЕМЫ ====================
  function applyTheme() {
    if (!overlayEl) {
      const exists = document.getElementById('cc-overlay');
      if (!exists) createOverlay();
      if (!overlayEl) return;
    }
    const th = THEMES[currentTheme] || THEMES.dark;
    const bgRgba = hexToRgba(th.bg, opacity);
    const headerRgba = hexToRgba(th.header, Math.min(100, opacity + 5));
    overlayEl.style.background = bgRgba;
    overlayEl.style.borderColor = th.border;
    overlayEl.style.color = th.text;
    overlayEl.style.width = overlayWidth + 'px';
    overlayEl.style.fontSize = fontScale + '%';
    overlayEl.style.opacity = '1';
    overlayEl.style.backdropFilter = blurEnabled ? 'blur(10px)' : 'none';
    overlayEl.style.webkitBackdropFilter = blurEnabled ? 'blur(10px)' : 'none';
    if (compactMode) overlayEl.classList.add('cc-compact'); else overlayEl.classList.remove('cc-compact');

    const header = document.getElementById('cc-header');
    if (header) {
      header.style.background = headerRgba;
      header.style.borderBottomColor = th.border;
      header.style.color = th.text;
    }

    const old = document.getElementById('cc-theme-accent');
    if (old) old.remove();
    const st = document.createElement('style');
    st.id = 'cc-theme-accent';
    st.textContent = `#cc-overlay .cc-dot.on{background:${accentColor}!important;box-shadow:0 0 8px ${hexToRgbaAlpha(accentColor, 0.5)}}
#cc-overlay #cc-toggle{background:${accentColor}!important;color:#111!important}
#cc-overlay .cc-depth-head span{color:${accentColor}!important;background:${hexToRgbaAlpha(accentColor, 0.15)}!important}
#cc-overlay .cc-presets button.active{background:${accentColor}!important;border-color:${accentColor}!important;color:#111!important}
#cc-overlay input[type=range]{accent-color:${accentColor}!important}
#cc-overlay{border-color:${th.border}!important}
#cc-overlay .cc-card,#cc-overlay .cc-status,#cc-overlay .cc-fen,#cc-overlay .cc-best,#cc-overlay .cc-depth{background:${th.card}!important;border-color:${th.border}!important;color:${th.text}!important}
#cc-overlay .cc-fen{color:${th.sub}!important}`;
    document.head.appendChild(st);

    if (highlightA) highlightA.style.background = hexToRgbaAlpha(hlFrom, hlFromOpacity / 100);
    if (highlightB) highlightB.style.background = hexToRgbaAlpha(hlTo, hlToOpacity / 100);
    log('theme applied:', currentTheme);
  }

  // ==================== ОЦЕНКА И СТАТУС ====================
  function updateEvalFromInfo(info) {
    const mateMatch = info.match(/score mate (-?\d+)/);
    if (mateMatch) {
      lastMate = parseInt(mateMatch[1], 10);
      lastEvalCp = lastMate > 0 ? CONFIG.mateCp : -CONFIG.mateCp;
      applyOverlayState();
      return;
    }
    const cpMatch = info.match(/score cp (-?\d+)/);
    if (cpMatch) {
      lastMate = null;
      lastEvalCp = parseInt(cpMatch[1], 10);
      applyOverlayState();
    }
  }

  function getWinEstimate() {
    if (!isMyTurn()) return '— ход соперника';
    if (lastMate !== null) {
      if (lastMate > 0) return 'Мат в ' + lastMate + ' ходов';
      return 'Мат против тебя в ' + Math.abs(lastMate) + ' ходов!';
    }
    const cp = lastEvalCp;
    const abs = Math.abs(cp);
    const side = cp >= 0 ? 'выигрываешь' : 'проигрываешь';
    if (abs < 50) return 'Равно - ~35+ ходов до конца';
    if (abs < 120) return 'Небольшой перевес (' + side + ') - ~25-30 ходов';
    if (abs < 300) return 'Перевес (' + side + ') - ~16-24 ходов';
    if (abs < 600) return 'Сильный перевес (' + side + ') - ~10-15 ходов';
    if (abs < 1000) return (cp > 0 ? 'Выигрыш' : 'Проигрыш') + ' - ~6-9 ходов';
    if (abs < 2000) return (cp > 0 ? 'Почти победа' : 'Критично') + ' - ~3-5 ходов';
    return (cp > 0 ? 'Победа близка' : 'Поражение близко') + ' - 1-2 хода';
  }

  function applyOverlayState() {
    if (!overlayEl) return;
    const dot = document.getElementById('cc-dot');
    const status = document.getElementById('cc-status');
    const toggle = document.getElementById('cc-toggle');
    const fenEl = document.getElementById('cc-fen');
    const bestEl = document.getElementById('cc-bestmove');
    const evalEl = document.getElementById('cc-eval');
    const fill = document.getElementById('cc-evalfill');
    const badge = document.getElementById('cc-depth-badge');
    const turnText = document.getElementById('cc-turn-text');
    const turnBadge = document.getElementById('cc-turn-badge');
    const winEl = document.getElementById('cc-win');

    let isMy = false;
    try {
      if (typeof window.__cc_hideOpponent !== 'undefined') hideOpponentMoves = !!window.__cc_hideOpponent;
      isMy = isMyTurn();
      if (!hideOpponentMoves) isMy = true;
    } catch (e) { isMy = true; }

    if (dot) {
      if (engineError) {
        dot.className = 'cc-dot';
        dot.style.background = '#ff6b6b';
        dot.style.boxShadow = '0 0 8px rgba(255,107,107,0.7)';
      } else {
        dot.style.background = '';
        dot.style.boxShadow = '';
        dot.className = 'cc-dot ' + (hackRunning ? (calculating ? 'calc' : 'on') : '');
      }
    }
    try {
      const ti = getTurnInfo();
      if (turnText) turnText.textContent = ti.isMyTurn ? 'Твой ход' : 'Ход соперника';
      if (turnBadge) {
        turnBadge.textContent = ti.activeColor === 'w' ? '● Белые' : '● Чёрные';
        turnBadge.style.background = ti.isMyTurn ? accentColor : '#3a3937';
        turnBadge.style.color = ti.isMyTurn ? '#111' : '#ccc';
        turnBadge.title = 'Ты: ' + ti.playerName + ' | Сейчас: ' + ti.activeName;
      }
    } catch (e) {}

    if (status) {
      if (engineError) status.textContent = 'Ошибка движка';
      else if (!hackRunning) status.textContent = 'Ожидает';
      else if (!isMy) status.textContent = 'Ход соперника — пауза';
      else status.textContent = calculating ? 'Считает…' : 'Работает';
    }
    if (toggle) {
      toggle.className = hackRunning ? 'cc-btn-stop' : 'cc-btn-primary';
      toggle.style.background = hackRunning ? '#ff6b6b' : accentColor;
      toggle.innerHTML = hackRunning ? '<span>■</span> Остановить' : '<span>▶</span> Запустить анализ';
    }
    if (badge) badge.textContent = 'd' + globalDepth;
    if (fenEl) fenEl.textContent = lastFen || '—';

    const bestCard = document.querySelector('#cc-overlay .cc-best');
    if (bestCard) {
      if (!isMy && hackRunning) {
        bestCard.style.opacity = '0.45';
        bestCard.style.pointerEvents = 'none';
      } else {
        bestCard.style.opacity = '1';
        bestCard.style.pointerEvents = 'auto';
      }
    }
    if (bestEl) {
      if (!isMy && hackRunning) {
        bestEl.textContent = '—';
        bestEl.title = 'Ход соперника — подсказка скрыта';
        clearHighlights();
      } else {
        if (lastBestMove) {
          const f = lastBestMove.slice(0, 2), t = lastBestMove.slice(2, 4);
          const promo = lastBestMove.length > 4 ? '=' + lastBestMove[4].toUpperCase() : '';
          bestEl.innerHTML = f + ' → ' + t + '<small style="font-size:10px;margin-left:6px">' + promo + ' d' + globalDepth + '</small>';
          bestEl.title = '';
        } else bestEl.textContent = '—';
      }
    }
    if (evalEl && fill) {
      if (!isMy && hackRunning) {
        evalEl.textContent = '—';
        evalEl.style.color = '#777';
        fill.style.width = '50%';
      } else if (lastMate !== null) {
        evalEl.textContent = 'M' + lastMate;
        evalEl.style.color = lastMate > 0 ? accentColor : '#ff6b6b';
        fill.style.width = lastMate > 0 ? '92%' : '8%';
      } else {
        const txt = lastEvalCp >= 0 ? '+' + (lastEvalCp / 100).toFixed(2) : '' + (lastEvalCp / 100).toFixed(2);
        evalEl.textContent = txt;
        evalEl.style.color = lastEvalCp > 60 ? accentColor : lastEvalCp < -60 ? '#ff6b6b' : '#f7c948';
        const pct = 50 + Math.max(-CONFIG.maxCp, Math.min(CONFIG.maxCp, lastEvalCp)) / 8;
        fill.style.width = pct + '%';
      }
    }
    if (winEl) {
      try {
        const txt = getWinEstimate();
        winEl.textContent = txt;
        if (!isMy && hackRunning) {
          winEl.style.opacity = '0.5';
          winEl.style.background = 'rgba(255,255,255,0.04)';
        } else {
          winEl.style.opacity = '0.95';
          if (lastMate !== null && lastMate > 0) winEl.style.background = 'rgba(129,182,76,0.18)';
          else if (lastMate !== null && lastMate < 0) winEl.style.background = 'rgba(255,107,107,0.18)';
          else winEl.style.background = 'rgba(0,0,0,0.15)';
        }
      } catch (e) { winEl.textContent = '—'; }
    }
  }

  // ==================== АНАЛИЗ ====================
  function analyzePosition() {
    if (!hackRunning || !engineWorker || !engineReady || engineError) return;
    const fen = getFullFen();
    if (!fen) return;
    if (fen === lastFen) return;
    lastFen = fen;
    lastBestMove = null;
    lastMate = null;
    clearHighlights();
    calculating = true;
    applyOverlayState();
    try {
      engineWorker.postMessage('position fen ' + fen);
      engineWorker.postMessage('go depth ' + globalDepth);
      armEngineWatchdog();
    } catch (e) {
      error('analyze postMessage failed', e);
      calculating = false;
      applyOverlayState();
    }
  }

  function scheduleAnalyze() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { analyzePosition(); }, CONFIG.analyzeDebounceMs);
  }

  function startObserver() {
    const board = document.querySelector('wc-chess-board');
    if (!board) return false;
    if (observer) observer.disconnect();
    observer = new MutationObserver(scheduleAnalyze);
    observer.observe(board, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    const moveList = document.querySelector('.vertical-move-list, #move-list, .live-game-buttons');
    if (moveList) observer.observe(moveList, { childList: true, subtree: true });
    return true;
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  }

  function stopHack() {
    log('stopHack');
    hackRunning = false;
    calculating = false;
    stopObserver();
    terminateEngine();
    clearHighlights();
    lastFen = '';
    applyOverlayState();
  }

  async function startHack() {
    log('startHack click', hackRunning);
    if (hackRunning) { stopHack(); return; }

    const board = document.querySelector('wc-chess-board');
    if (!board) {
      warn('board not found');
      if (overlayEl) {
        overlayEl.classList.remove('cc-hidden');
        const fe = document.getElementById('cc-fen');
        if (fe) fe.textContent = 'Доска не найдена — открой партию';
      } else {
        alert('Board not found');
      }
      return;
    }

    hackRunning = true;
    calculating = true;
    applyOverlayState();

    let eng;
    try {
      eng = await createEngineWorker();
    } catch (e) {
      error('createEngine failed', e);
      hackRunning = false;
      calculating = false;
      applyOverlayState();
      return;
    }

    if (!eng || engineError) {
      hackRunning = false;
      calculating = false;
      applyOverlayState();
      return;
    }

    // UCI handshake
    try { engineWorker.postMessage('uci'); } catch (e) {}

    let obsOk = false;
    try { obsOk = startObserver(); } catch (e) { error(e); }
    if (!obsOk) {
      hackRunning = false;
      calculating = false;
      applyOverlayState();
      return;
    }

    if (overlayEl) overlayEl.classList.remove('cc-hidden');
    log('hack started');
    setTimeout(() => { lastFen = ''; analyzePosition(); }, 320);
  }

  // ==================== СООБЩЕНИЯ ОТ POPUP / BACKGROUND ====================
  function handleMessage(msg, sender, sendResponse) {
    if (!msg || !msg.type) return;

    if (msg.type === 'getStatus') {
      let ti = null;
      try { ti = getTurnInfo(); } catch (e) {}
      let outMove = lastBestMove;
      let outEval = lastMate !== null ? (lastMate > 0 ? CONFIG.mateCp : -CONFIG.mateCp) : lastEvalCp;
      let outMate = lastMate;
      try {
        let hide = hideOpponentMoves;
        try { if (typeof window.__cc_hideOpponent !== 'undefined') hide = !!window.__cc_hideOpponent; } catch (e) {}
        if (hide && ti && !ti.isMyTurn) {
          outMove = null;
          outEval = null;
          outMate = null;
        }
      } catch (e) {}
      sendResponse({
        hackRunning, calculating, bestMove: outMove, evalCp: outEval, mate: outMate,
        fen: lastFen, depth: globalDepth, showHighlights, theme: currentTheme, accent: accentColor,
        opacity, overlayWidth, fontScale, blur: blurEnabled, compact: compactMode,
        hlFrom, hlTo, turnInfo: ti, engineError
      });
      return true;
    }
    if (msg.type === 'getTurn') {
      try { const ti = getTurnInfo(); sendResponse(ti); } catch (e) { sendResponse(null); }
      return true;
    }
    if (msg.type === 'setDepth') {
      let v = parseInt(msg.depth, 10);
      if (!isNaN(v)) { setDepth(v); }
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'setHighlight') {
      showHighlights = !!msg.value;
      const cb = document.getElementById('cc-hl');
      if (cb) cb.checked = showHighlights;
      storageSet({ showHighlights });
      if (!showHighlights) clearHighlights();
      else if (lastBestMove) renderBestMove(lastBestMove);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'setTheme') {
      let need = false;
      if (msg.theme && THEMES[msg.theme]) { currentTheme = msg.theme; storageSet({ theme: currentTheme }); need = true; }
      if (msg.accent) { accentColor = msg.accent; storageSet({ accent: accentColor }); need = true; }
      if (msg.opacity !== undefined) { opacity = parseInt(msg.opacity, 10); storageSet({ opacity }); need = true; }
      if (msg.overlayWidth !== undefined) { overlayWidth = parseInt(msg.overlayWidth, 10); storageSet({ overlayWidth }); need = true; }
      if (msg.fontScale !== undefined) { fontScale = parseInt(msg.fontScale, 10); storageSet({ fontScale }); need = true; }
      if (msg.blur !== undefined) { blurEnabled = !!msg.blur; storageSet({ blur: blurEnabled }); need = true; }
      if (msg.compact !== undefined) { compactMode = !!msg.compact; storageSet({ compact: compactMode }); need = true; }
      if (msg.hlFrom) { hlFrom = msg.hlFrom; storageSet({ hlFrom }); need = true; }
      if (msg.hlTo) { hlTo = msg.hlTo; storageSet({ hlTo }); need = true; }
      if (msg.hlFromOpacity !== undefined) { hlFromOpacity = parseInt(msg.hlFromOpacity, 10); storageSet({ hlFromOpacity }); need = true; }
      if (msg.hlToOpacity !== undefined) { hlToOpacity = parseInt(msg.hlToOpacity, 10); storageSet({ hlToOpacity }); need = true; }
      if (need) applyTheme();
      if (overlayEl && overlayEl.classList.contains('cc-hidden')) {
        overlayEl.classList.remove('cc-hidden');
        storageSet({ overlayHidden: false });
      }
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'toggle') {
      if (hackRunning) stopHack(); else startHack();
      sendResponse({ hackRunning });
      return true;
    }
    if (msg.type === 'showOverlay') {
      if (overlayEl) { overlayEl.classList.remove('cc-hidden'); storageSet({ overlayHidden: false }); }
      else createOverlay();
      applyTheme();
      sendResponse({ ok: true });
      return true;
    }
  }

  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(handleMessage);
    }
  } catch (e) {}

  // ==================== ИНИЦИАЛИЗАЦИЯ ====================
  async function init() {
    const cfg = await storageGet({
      depth: 4, showHighlights: true, overlayPos: null, overlayMinimized: false, overlayHidden: false,
      theme: 'dark', accent: '#81b64c', opacity: 100, overlayWidth: 300, fontScale: 100,
      blur: true, compact: false, hlFrom: '#81b64c', hlFromOpacity: 55, hlTo: '#f7c948', hlToOpacity: 65
    });
    globalDepth = Math.max(CONFIG.minDepth, Math.min(CONFIG.maxDepth, parseInt(cfg.depth, 10) || CONFIG.defaultDepth));
    showHighlights = !!cfg.showHighlights;
    isMinimized = !!cfg.overlayMinimized;
    currentTheme = THEMES[cfg.theme] ? cfg.theme : 'dark';
    accentColor = cfg.accent || '#81b64c';
    opacity = Math.max(40, Math.min(100, parseInt(cfg.opacity, 10) || 100));
    overlayWidth = Math.max(260, Math.min(420, parseInt(cfg.overlayWidth, 10) || 300));
    fontScale = Math.max(85, Math.min(125, parseInt(cfg.fontScale, 10) || 100));
    blurEnabled = !!cfg.blur;
    compactMode = !!cfg.compact;
    hlFrom = cfg.hlFrom || '#81b64c';
    hlTo = cfg.hlTo || '#f7c948';
    hlFromOpacity = Math.max(20, Math.min(100, parseInt(cfg.hlFromOpacity, 10) || 55));
    hlToOpacity = Math.max(20, Math.min(100, parseInt(cfg.hlToOpacity, 10) || 65));

    createOverlay();
    if (cfg.overlayPos && cfg.overlayPos.left && cfg.overlayPos.top && overlayEl) {
      overlayEl.style.left = cfg.overlayPos.left;
      overlayEl.style.top = cfg.overlayPos.top;
      overlayEl.style.right = 'auto';
    }
    if (cfg.overlayHidden && overlayEl) overlayEl.classList.add('cc-hidden');
    if (isMinimized && overlayEl) {
      overlayEl.classList.add('cc-minimized');
      const mb = document.getElementById('cc-min');
      if (mb) mb.textContent = '+';
    }
    const r = document.getElementById('cc-range');
    if (r) r.value = globalDepth;
    const dv = document.getElementById('cc-depthval');
    if (dv) dv.textContent = globalDepth;
    const hl = document.getElementById('cc-hl');
    if (hl) hl.checked = showHighlights;
    applyOverlayState();
    applyTheme();

    // Обновление состояния оверлея только когда он виден
    setInterval(() => {
      try {
        if (overlayEl && !overlayEl.classList.contains('cc-hidden')) applyOverlayState();
      } catch (e) {}
    }, CONFIG.overlayPollMs);

    let lastUrl = location.href;
    setInterval(() => {
      try {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          clearHighlights();
          lastFen = '';
          if (hackRunning) {
            stopObserver();
            setTimeout(() => { startObserver(); }, 1000);
            scheduleAnalyze();
          }
          if (overlayEl && !overlayEl.classList.contains('cc-hidden') && !document.getElementById('cc-overlay')) {
            createOverlay();
            applyTheme();
          }
        }
        if (!document.getElementById('cc-overlay') && !cfg.overlayHidden) {
          createOverlay();
          applyTheme();
        }
      } catch (e) {}
    }, CONFIG.urlPollMs);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  log('init done');
})();
