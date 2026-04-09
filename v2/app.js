import { loadState, saveState } from './storage.js';
import { POLL_INTERVAL } from './utils.js';
import { getSelectedDialog, state } from './state.js';
import { pullMessages, registerDirectSender } from './chats.js';
import { initUi, openAccountModal, renderAll } from './ui.js';
import { ensureDirectForPeer, pollSignalServer, sendDirectChatPayload } from './webrtc.js';

let pollTimer = null;
let signalTimer = null;
let viewTimer = null;
let ackCheckTimer = null;

function hydrateConnectionFields() {
  const hostInput = document.getElementById('hostInput');
  const portInput = document.getElementById('portInput');
  const pathInput = document.getElementById('pathInput');
  const stunPathInput = document.getElementById('stunPathInput');

  if (hostInput) hostInput.value = state.connection.host;
  if (portInput) portInput.value = state.connection.port;
  if (pathInput) pathInput.value = state.connection.path;
  if (stunPathInput) stunPathInput.value = state.connection.stunPath;

  [hostInput, portInput, pathInput, stunPathInput].forEach((input) => {
    input?.addEventListener('input', () => {
      state.connection.host = hostInput?.value || state.connection.host;
      state.connection.port = portInput?.value || state.connection.port;
      state.connection.path = pathInput?.value || state.connection.path;
      state.connection.stunPath = stunPathInput?.value || state.connection.stunPath;
      saveState();
      renderAll({ preserveScroll: true });
    });
  });
}

function shouldPollSignal() {
  const selectedDialog = getSelectedDialog();
  if (selectedDialog) return true;

  return Object.values(state.webrtc.byPeerGuid || {}).some((runtime) => {
    return runtime && (
      runtime.callState === 'calling' ||
      runtime.callState === 'incoming' ||
      runtime.callState === 'active'
    );
  });
}

function shouldLiveRerender() {
  const selectedDialog = getSelectedDialog();
  if (selectedDialog) return true;

  return Object.values(state.webrtc.byPeerGuid || {}).some((runtime) => {
    return runtime && (
      runtime.callState === 'calling' ||
      runtime.callState === 'incoming' ||
      runtime.callState === 'active'
    );
  });
}

async function ensureSelectedDialogDirect() {
  const selectedDialog = getSelectedDialog();
  if (!selectedDialog) return;
  await ensureDirectForPeer(selectedDialog.peerGuid, selectedDialog.peerNickname);
}

async function pollAll() {
  if (!state.accounts.length) return;

  try {
    state.syncing = true;
    await pullMessages();
  } catch (_) {
  } finally {
    state.syncing = false;
  }

  renderAll({ preserveScroll: true });
}

/**
 * Проверяет pending сообщения без ACK и запускает повторную отправку.
 */
function checkPendingMessages() {
  for (const [peerGuid, runtime] of Object.entries(state.webrtc.byPeerGuid || {})) {
    if (!runtime || !runtime.pendingMessages) continue;

    const now = Date.now();
    for (const [msgGuid, pending] of Object.entries(runtime.pendingMessages)) {
      if (!pending) continue;

      const elapsed = now - (pending.timerAt || 0);
      if (elapsed >= 3000) {
        // Импортируем retryPendingMessage динамически чтобы избежать циклических зависимостей
        import('./chats.js').then(({ retryPendingMessage }) => {
          retryPendingMessage(peerGuid, msgGuid);
        }).catch(() => {});
      }
    }
  }
}

function startPollers() {
  clearInterval(pollTimer);
  clearInterval(signalTimer);
  clearInterval(viewTimer);
  clearInterval(ackCheckTimer);

  pollTimer = setInterval(() => {
    pollAll().catch(() => {});
  }, POLL_INTERVAL);

  signalTimer = setInterval(() => {
    if (!shouldPollSignal()) return;
    pollSignalServer()
      .then(() => renderAll({ preserveScroll: true }))
      .catch(() => {});
  }, 1000);

  viewTimer = setInterval(() => {
    if (!shouldLiveRerender()) return;
    renderAll({ preserveScroll: true });
  }, 1000);

  // Проверяем pending сообщения каждые 2 секунды
  ackCheckTimer = setInterval(() => {
    checkPendingMessages();
  }, 2000);
}

async function init() {
  loadState();
  initUi();
  hydrateConnectionFields();
  registerDirectSender(sendDirectChatPayload);

  window.addEventListener('telegram-ui-refresh', () => {
    renderAll({ preserveScroll: true });
  });

  renderAll();

  if (state.firstAccountRequired || !state.accounts.length) {
    openAccountModal();
  } else {
    await ensureSelectedDialogDirect();
    await pollAll();
  }

  startPollers();
}

init();
