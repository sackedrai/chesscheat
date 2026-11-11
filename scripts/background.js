/**
 * ChessCheat — Service Worker (Manifest V3)
 * Маршрутизирует сообщения между popup и контент-скриптом,
 * хранит флаг активности вкладки chess.com.
 */

(() => {
  'use strict';

  const CHESS_HOSTS = ['chess.com', 'www.chess.com'];

  function isChessTab(url) {
    try {
      const hostname = new URL(url).hostname;
      return CHESS_HOSTS.includes(hostname);
    } catch (e) {
      return false;
    }
  }

  // Сохраняем последнюю известную вкладку chess.com, чтобы popup
  // мог обратиться к контент-скрипту даже когда окно popup открыто
  // на другой вкладке.
  let lastChessTabId = null;

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && isChessTab(tab.url)) {
      lastChessTabId = tabId;
    }
  });

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs.get(tabId, (tab) => {
      if (tab && isChessTab(tab.url)) lastChessTabId = tabId;
    });
  });

  // Проксируем сообщения от popup к контент-скрипту активной/запомненной вкладки
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) {
      return false;
    }

    const targetTabId = sender.tab ? sender.tab.id : lastChessTabId;
    const tabId = targetTabId && isChessTab(sender.tab ? sender.tab.url : '') ? targetTabId : lastChessTabId;

    if (!tabId) {
      sendResponse(null);
      return true;
    }

    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse(null);
      } else {
        sendResponse(response);
      }
    });

    return true; // keep channel open for async sendResponse
  });

  console.log('[ChessCheat] background service worker started');
})();
