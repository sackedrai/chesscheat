(() => {
  'use strict';

  const $ = (s) => document.getElementById(s);
  const els = {
    depthSlider: $('depthSlider'),
    depthValue: $('depthValue'),
    toggleBtn: $('toggleBtn'),
    highlightToggle: $('highlightToggle'),
    statusDot: $('statusDot'),
    statusText: $('statusText'),
    bestMoveBadge: $('bestMoveBadge'),
    evalFill: $('evalFill'),
    evalText: $('evalText'),
    fenPreview: $('fenPreview'),
    openOverlayBtn: $('openOverlayBtn'),
    pageBadge: $('pageBadge'),
    notChessWarn: $('notChessWarn'),
    themeBadge: $('themeBadge'),
    accentPicker: $('accentPicker'),
    accentVal: $('accentVal'),
    opacitySlider: $('opacitySlider'),
    opacityVal: $('opacityVal'),
    widthSlider: $('widthSlider'),
    widthVal: $('widthVal'),
    fontSlider: $('fontSlider'),
    fontVal: $('fontVal'),
    blurToggle: $('blurToggle'),
    compactToggle: $('compactToggle'),
    hlFromPicker: $('hlFromPicker'),
    hlToPicker: $('hlToPicker'),
    hlFromVal: $('hlFromVal'),
    hlToVal: $('hlToVal'),
    hlFromOpacity: $('hlFromOpacity'),
    hlToOpacity: $('hlToOpacity'),
    resetThemeBtn: $('resetThemeBtn'),
  };

  let lastMove = '—';
  let pollTimer = null;
  let isPolling = false;

  function isChessTab(url) { return url && url.includes('chess.com'); }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function sendToContent(msg) {
    const tab = await getActiveTab();
    if (!tab || !isChessTab(tab.url)) return null;
    try { return await chrome.tabs.sendMessage(tab.id, msg); } catch (e) { return null; }
  }

  function setStatus(running, calculating, engineError) {
    if (engineError) {
      els.statusDot.className = 'dot';
      els.statusText.textContent = 'Ошибка движка';
      els.statusDot.style.background = '#ff6b6b';
      els.statusDot.style.boxShadow = '0 0 8px rgba(255,107,107,0.6)';
    } else {
      els.statusDot.className = 'dot ' + (running ? (calculating ? 'calc' : 'on') : '');
      els.statusText.textContent = running ? (calculating ? 'Считает…' : 'Работает') : 'Ожидает';
    }
    els.toggleBtn.className = 'btn ' + (running ? 'btn-primary stop' : 'btn-primary');
    els.toggleBtn.innerHTML = running ? '<span class="btn-icon">■</span> Остановить' : '<span class="btn-icon">▶</span> Запустить';
    els.pageBadge.textContent = running ? 'active' : 'idle';
    els.pageBadge.className = 'badge ' + (running ? 'badge-on' : 'badge-off');
  }

  function setEval(cp) {
    let pct = 50 + Math.max(-400, Math.min(400, cp)) / 8;
    els.evalFill.style.width = pct + '%';
    const txt = cp >= 0 ? '+' + (cp / 100).toFixed(2) : '' + (cp / 100).toFixed(2);
    els.evalText.textContent = txt;
    els.evalText.style.color = cp > 60 ? '#81b64c' : cp < -60 ? '#ff6b6b' : '#f7c948';
  }

  function setTurnInfo(info) {
    const turnText = $('turnText');
    const turnBadge = $('turnBadge');
    const winEl = $('winEstimate');
    const bestBadge = els.bestMoveBadge;
    if (!info || !turnText) return;
    turnText.textContent = info.isMyTurn ? 'Твой ход' : 'Ход соперника';
    turnText.style.color = info.isMyTurn ? '#81b64c' : '#9e9e9e';
    if (turnBadge) {
      turnBadge.textContent = info.activeColor === 'w' ? '● Белые' : '● Чёрные';
      turnBadge.style.background = info.isMyTurn ? '#1d4023' : '#2a2a2a';
      turnBadge.style.color = info.isMyTurn ? '#81b64c' : '#ccc';
      turnBadge.style.border = '1px solid ' + (info.isMyTurn ? '#2a5a2e' : '#444');
    }
    if (bestBadge) {
      if (!info.isMyTurn) {
        bestBadge.textContent = '—';
        bestBadge.style.opacity = '0.4';
        bestBadge.title = 'Ход соперника — скрыто';
      } else {
        bestBadge.style.opacity = '1';
        bestBadge.title = '';
        if (lastMove && lastMove !== '—') bestBadge.textContent = lastMove;
      }
    }
    if (winEl) {
      if (!info.isMyTurn) {
        winEl.textContent = '⏸ Ход соперника — оценка скрыта';
        winEl.style.background = 'rgba(255,255,255,0.06)';
        winEl.style.color = '#888';
      } else {
        winEl.style.borderColor = '#2a5a2e';
      }
    }
  }

  function setWinEstimate(cp, mate, isMyTurn) {
    const winEl = $('winEstimate');
    if (!winEl) return;
    if (!isMyTurn) {
      winEl.textContent = '⏸ Ход соперника — оценка скрыта';
      winEl.style.background = 'rgba(255,255,255,0.06)';
      winEl.style.color = '#888';
      return;
    }
    let text = '—';
    let bg = 'rgba(129,182,76,0.12)';
    let color = '#ddd';
    let border = '#2a5a2e';
    if (mate !== null && mate !== undefined) {
      if (mate > 0) { text = 'Мат в ' + mate + ' ходов'; bg = 'rgba(129,182,76,0.22)'; color = '#81b64c'; }
      else { text = 'Мат против тебя в ' + Math.abs(mate) + ' ходов!'; bg = 'rgba(255,107,107,0.18)'; color = '#ff6b6b'; border = '#5a2a2a'; }
    } else if (typeof cp === 'number') {
      const abs = Math.abs(cp);
      const side = cp >= 0 ? 'выигрываешь' : 'проигрываешь';
      if (abs < 50) { text = 'Равно — ≈ 35+ ходов'; bg = 'rgba(255,255,255,0.06)'; }
      else if (abs < 120) { text = 'Небольшой перевес (' + side + ') — ≈ 25-30 ходов'; }
      else if (abs < 300) { text = 'Перевес (' + side + ') — ≈ 16-24 ходов'; }
      else if (abs < 600) { text = 'Сильный перевес (' + side + ') — ≈ 10-15 ходов'; bg = 'rgba(129,182,76,0.18)'; color = '#81b64c'; }
      else if (abs < 1000) { text = (cp > 0 ? 'Выигрыш' : 'Проигрыш') + ' — ≈ 6-9 ходов'; bg = cp > 0 ? 'rgba(129,182,76,0.18)' : 'rgba(255,107,107,0.12)'; color = cp > 0 ? '#81b64c' : '#ff9e9e'; }
      else if (abs < 2000) { text = (cp > 0 ? 'Почти победа' : 'Критично') + ' — ≈ 3-5 ходов'; bg = cp > 0 ? 'rgba(129,182,76,0.22)' : 'rgba(255,107,107,0.18)'; }
      else { text = (cp > 0 ? 'Победа близка' : 'Поражение близко') + ' — 1-2 хода'; bg = cp > 0 ? 'rgba(129,182,76,0.25)' : 'rgba(255,107,107,0.22)'; }
    }
    winEl.textContent = text;
    winEl.style.background = bg;
    winEl.style.color = color;
    winEl.style.borderColor = border;
  }

  function refreshDepthUI(v) {
    v = Math.max(2, Math.min(6, parseInt(v, 10) || 4));
    els.depthValue.textContent = v;
    els.depthSlider.value = v;
    document.querySelectorAll('.presets button').forEach(function(b) {
      b.classList.toggle('active', parseInt(b.getAttribute('data-depth'), 10) === parseInt(v, 10));
    });
  }
  function refreshThemeUI(theme) {
    els.themeBadge.textContent = theme;
    document.querySelectorAll('.theme-btn').forEach(function(b) {
      b.classList.toggle('active', b.getAttribute('data-theme') === theme);
    });
  }

  const DEFAULTS = {
    depth: 4, showHighlights: true,
    theme: 'dark', accent: '#81b64c', opacity: 100, overlayWidth: 300, fontScale: 100,
    blur: true, compact: false,
    hlFrom: '#81b64c', hlFromOpacity: 55, hlTo: '#f7c948', hlToOpacity: 65,
  };

  // Опрос только если мы на chess.com и (расширение активно или только что открыта вкладка)
  function shouldPoll(onChess, resp) {
    if (!onChess) return false;
    if (!resp) return false;
    return resp.hackRunning || resp.calculating || resp.engineError;
  }

  async function startPolling() {
    if (isPolling) return;
    isPolling = true;
    while (isPolling) {
      const tab = await getActiveTab();
      const onChess = isChessTab(tab && tab.url);
      if (!onChess) {
        isPolling = false;
        return;
      }
      const resp = await sendToContent({ type: 'getStatus' });
      if (resp) {
        setStatus(resp.hackRunning, resp.calculating, resp.engineError);
        const isMy = resp.turnInfo ? resp.turnInfo.isMyTurn : true;
        if (resp.bestMove && isMy) { lastMove = resp.bestMove; els.bestMoveBadge.textContent = resp.bestMove; }
        else if (!isMy) { els.bestMoveBadge.textContent = '—'; }
        if (resp.fen) els.fenPreview.textContent = resp.fen;
        if (typeof resp.evalCp === 'number') {
          if (isMy) setEval(resp.evalCp);
          else { els.evalText.textContent = '—'; els.evalFill.style.width = '50%'; }
          setWinEstimate(isMy ? resp.evalCp : null, resp.mate !== undefined ? resp.mate : null, isMy);
        }
        if (resp.depth) refreshDepthUI(resp.depth);
        if (resp.turnInfo) setTurnInfo(resp.turnInfo);
      } else {
        setStatus(false, false, false);
        els.bestMoveBadge.textContent = '—';
        els.fenPreview.textContent = 'Открой игру, оверлей загрузится';
        setWinEstimate(null, null, false);
        isPolling = false;
        return;
      }
      // Если анализ не läuft и нет ошибок — прекращаем опрос (экономия ресурсов)
      if (!shouldPoll(onChess, resp)) {
        isPolling = false;
        return;
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    isPolling = false;
  }

  async function stopPolling() {
    isPolling = false;
  }

  async function loadState() {
    const tab = await getActiveTab();
    const onChess = isChessTab(tab && tab.url);
    els.notChessWarn.classList.toggle('hidden', onChess);
    els.toggleBtn.disabled = !onChess;
    els.pageBadge.textContent = onChess ? 'ready' : 'offline';

    const stored = await chrome.storage.local.get(DEFAULTS);
    refreshDepthUI(stored.depth);
    els.highlightToggle.checked = stored.showHighlights;
    refreshThemeUI(stored.theme);
    els.accentPicker.value = stored.accent;
    els.accentVal.textContent = stored.accent;
    els.opacitySlider.value = stored.opacity;
    els.opacityVal.textContent = stored.opacity + '%';
    els.widthSlider.value = stored.overlayWidth;
    els.widthVal.textContent = stored.overlayWidth + 'px';
    els.fontSlider.value = stored.fontScale;
    els.fontVal.textContent = stored.fontScale + '%';
    els.blurToggle.checked = stored.blur;
    els.compactToggle.checked = stored.compact;
    els.hlFromPicker.value = stored.hlFrom;
    els.hlToPicker.value = stored.hlTo;
    els.hlFromVal.textContent = stored.hlFrom;
    els.hlToVal.textContent = stored.hlTo;
    els.hlFromOpacity.value = stored.hlFromOpacity;
    els.hlToOpacity.value = stored.hlToOpacity;

    await stopPolling();

    if (onChess) {
      const resp = await sendToContent({ type: 'getStatus' });
      if (resp) {
        setStatus(resp.hackRunning, resp.calculating, resp.engineError);
        const isMy = resp.turnInfo ? resp.turnInfo.isMyTurn : true;
        if (resp.bestMove && isMy) { lastMove = resp.bestMove; els.bestMoveBadge.textContent = resp.bestMove; }
        else if (!isMy) { els.bestMoveBadge.textContent = '—'; }
        if (resp.fen) els.fenPreview.textContent = resp.fen;
        if (typeof resp.evalCp === 'number') {
          if (isMy) setEval(resp.evalCp);
          else { els.evalText.textContent = '—'; els.evalFill.style.width = '50%'; }
          setWinEstimate(isMy ? resp.evalCp : null, resp.mate !== undefined ? resp.mate : null, isMy);
        }
        if (resp.depth) refreshDepthUI(resp.depth);
        if (resp.turnInfo) setTurnInfo(resp.turnInfo);
        else {
          const ti = await sendToContent({ type: 'getTurn' });
          if (ti) setTurnInfo(ti);
        }
        // Запускаем фоновый опрос только если анализ активен
        if (resp.hackRunning || resp.calculating || resp.engineError) {
          await startPolling();
        }
      } else {
        setStatus(false, false, false);
        els.bestMoveBadge.textContent = '—';
        els.fenPreview.textContent = 'Открой игру, оверлей загрузится';
        setWinEstimate(null, null, false);
      }
    } else setStatus(false, false, false);
  }

  async function saveThemePatch(patch) {
    await chrome.storage.local.set(patch);
    sendToContent({ type: 'setTheme', ...patch });
  }

  // ===== СЛУШАТЕЛИ =====
  els.depthSlider.addEventListener('input', async function (e) {
    const v = parseInt(e.target.value, 10);
    refreshDepthUI(v);
    await chrome.storage.local.set({ depth: v });
    sendToContent({ type: 'setDepth', depth: v });
  });
  document.querySelectorAll('.presets button').forEach(function (b) {
    b.addEventListener('click', async function () {
      const v = parseInt(b.getAttribute('data-depth'), 10);
      refreshDepthUI(v);
      await chrome.storage.local.set({ depth: v });
      sendToContent({ type: 'setDepth', depth: v });
    });
  });
  els.highlightToggle.addEventListener('change', async function (e) {
    await chrome.storage.local.set({ showHighlights: e.target.checked });
    sendToContent({ type: 'setHighlight', value: e.target.checked });
  });
  els.toggleBtn.addEventListener('click', async function () {
    els.toggleBtn.disabled = true;
    await sendToContent({ type: 'toggle' });
    setTimeout(async function () {
      els.toggleBtn.disabled = false;
      const s = await sendToContent({ type: 'getStatus' });
      if (s) {
        setStatus(s.hackRunning, s.calculating, s.engineError);
        lastMove = s.bestMove || lastMove;
        if (s.turnInfo && s.turnInfo.isMyTurn) els.bestMoveBadge.textContent = lastMove;
        if (s.hackRunning || s.calculating || s.engineError) await startPolling();
        else await stopPolling();
      }
    }, 400);
  });
  els.openOverlayBtn.addEventListener('click', async function () {
    await sendToContent({ type: 'showOverlay' });
    window.close();
  });

  document.querySelectorAll('.theme-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      const t = b.getAttribute('data-theme');
      refreshThemeUI(t);
      saveThemePatch({ theme: t });
    });
  });
  els.accentPicker.addEventListener('input', function (e) { els.accentVal.textContent = e.target.value; saveThemePatch({ accent: e.target.value }); });
  els.opacitySlider.addEventListener('input', function (e) { els.opacityVal.textContent = e.target.value + '%'; saveThemePatch({ opacity: parseInt(e.target.value, 10) }); });
  els.widthSlider.addEventListener('input', function (e) { els.widthVal.textContent = e.target.value + 'px'; saveThemePatch({ overlayWidth: parseInt(e.target.value, 10) }); });
  els.fontSlider.addEventListener('input', function (e) { els.fontVal.textContent = e.target.value + '%'; saveThemePatch({ fontScale: parseInt(e.target.value, 10) }); });
  els.blurToggle.addEventListener('change', function (e) { saveThemePatch({ blur: e.target.checked }); });
  els.compactToggle.addEventListener('change', function (e) { saveThemePatch({ compact: e.target.checked }); });
  els.hlFromPicker.addEventListener('input', function (e) { els.hlFromVal.textContent = e.target.value; saveThemePatch({ hlFrom: e.target.value }); });
  els.hlToPicker.addEventListener('input', function (e) { els.hlToVal.textContent = e.target.value; saveThemePatch({ hlTo: e.target.value }); });
  els.hlFromOpacity.addEventListener('input', function (e) { saveThemePatch({ hlFromOpacity: parseInt(e.target.value, 10) }); });
  els.hlToOpacity.addEventListener('input', function (e) { saveThemePatch({ hlToOpacity: parseInt(e.target.value, 10) }); });
  els.resetThemeBtn.addEventListener('click', async function () {
    if (!confirm('Сбросить все настройки к значениям по умолчанию?')) return;
    await chrome.storage.local.set(DEFAULTS);
    await chrome.storage.local.set({ depth: DEFAULTS.depth, showHighlights: true });
    loadState();
    sendToContent({ type: 'setTheme', ...DEFAULTS });
    sendToContent({ type: 'setDepth', depth: DEFAULTS.depth });
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes.depth) refreshDepthUI(changes.depth.newValue);
    if (changes.theme) refreshThemeUI(changes.theme.newValue);
  });

  document.addEventListener('DOMContentLoaded', loadState);
  loadState();
})();
