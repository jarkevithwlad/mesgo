import { sanitizeHost, sanitizePath, sanitizePort } from './utils.js';

export const STORAGE_KEY = 'telegram_visual_clone_v2';

export const state = {
  connection: {
    host: '127.0.0.1',
    port: '3000',
    path: '/messages_v1',
    stunPath: '/messages_v1/stun'
  },
  accounts: [],
  activeAccountId: '',
  search: '',
  syncing: false,
  chatContextPeerGuid: '',
  chatContextPeerNickname: '',
  firstAccountRequired: false,
  ui: {
    settingsOpen: false,
    newChatOpen: false,
    accountOpen: false
  },
  webrtc: {
    byPeerGuid: {},
    pingTimers: {},
    retryTimers: {},
    handshakeTimers: {},
    ackTimers: {},
    ackRetryTimers: {}
  },
  calls: {
    byPeerGuid: {}
  }
};

export function resetTransientState() {
  state.search = '';
  state.syncing = false;
  state.chatContextPeerGuid = '';
  state.chatContextPeerNickname = '';
  state.ui.settingsOpen = false;
  state.ui.newChatOpen = false;
  state.ui.accountOpen = false;
}

export function getActiveAccount() {
  return state.accounts.find((acc) => acc.id === state.activeAccountId) || null;
}

export function hasAccounts() {
  return state.accounts.length > 0;
}

export function hasActiveAccount() {
  return Boolean(getActiveAccount());
}

export function getDialogMap() {
  const account = getActiveAccount();
  return account ? account.dialogs : {};
}

export function getSelectedPeerGuid() {
  const account = getActiveAccount();
  return account ? account.selectedPeerGuid || '' : '';
}

export function setSelectedPeerGuid(value) {
  const account = getActiveAccount();
  if (!account) return;
  account.selectedPeerGuid = value || '';
}

export function getSelectedDialog() {
  const dialogs = getDialogMap();
  const peerGuid = getSelectedPeerGuid();
  return peerGuid ? dialogs[peerGuid] || null : null;
}

export function getDialogArray() {
  return Object.values(getDialogMap()).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

export function getEndpoint(kind = 'messages', bookPath = null) {
  const host = sanitizeHost(state.connection.host);
  const port = sanitizePort(state.connection.port);

  if (bookPath) {
    if (!host || !port) return '';
    return `https://${host}:${port}${bookPath}`;
  }

  const path = kind === 'stun'
    ? sanitizePath(state.connection.stunPath || '/messages_v1/stun', '/messages_v1/stun')
    : sanitizePath(state.connection.path || '/messages_v1', '/messages_v1');

  if (!host || !port) return '';
  return `https://${host}:${port}${path}`;
}

export function getPeerRuntime(peerGuid) {
  if (!state.webrtc.byPeerGuid[peerGuid]) {
    state.webrtc.byPeerGuid[peerGuid] = {
      status: 'idle',
      statusText: 'Нет прямого соединения',
      pingMs: null,
      lastDirectMessageAt: 0,
      lastHandshakeAt: 0,
      lastHandshakeResponseAt: 0,
      directReady: false,
      callEnabled: false,
      isInitiator: false,
      pc: null,
      dc: null,
      makingOffer: false,
      ignoreOffer: false,
      polite: false,
      localStream: null,
      remoteStream: null,
      remoteCandidatesQueue: [],
      seenSignalIds: {},
      audioEnabled: true,
      callState: 'idle',
      incomingCall: false,
      activeCall: false,
      lastPingSentAt: 0,
      lastPongAt: 0,
      // ACK tracking
      pendingMessages: {},       // {msg_guid: {payload, retries, timerAt}}
      receivedMsgGuids: {},      // {msg_guid: true} — уже обработанные сообщения
      receivedAckGuids: {},      // {msg_guid: true} — подтверждённые
      // Handshake
      lastHandshakeSentAt: 0,
      handshakePending: false,
      // Connection epoch
      connectionEpoch: Date.now(),
      minSignalTimestamp: 0
    };
  }

  return state.webrtc.byPeerGuid[peerGuid];
}

export function clearPeerRuntime(peerGuid) {
  const runtime = state.webrtc.byPeerGuid[peerGuid];
  if (!runtime) return;

  // Очистка всех таймеров
  const ackTimer = state.webrtc.ackTimers[peerGuid];
  if (ackTimer) {
    Object.values(ackTimer).forEach((t) => clearTimeout(t));
    delete state.webrtc.ackTimers[peerGuid];
  }

  const ackRetryTimer = state.webrtc.ackRetryTimers[peerGuid];
  if (ackRetryTimer) {
    Object.values(ackRetryTimer).forEach((t) => clearTimeout(t));
    delete state.webrtc.ackRetryTimers[peerGuid];
  }

  delete state.webrtc.byPeerGuid[peerGuid];

  const pingTimer = state.webrtc.pingTimers[peerGuid];
  if (pingTimer) {
    clearInterval(pingTimer);
    delete state.webrtc.pingTimers[peerGuid];
  }

  const retryTimer = state.webrtc.retryTimers[peerGuid];
  if (retryTimer) {
    clearInterval(retryTimer);
    delete state.webrtc.retryTimers[peerGuid];
  }

  const handshakeTimer = state.webrtc.handshakeTimers[peerGuid];
  if (handshakeTimer) {
    clearInterval(handshakeTimer);
    delete state.webrtc.handshakeTimers[peerGuid];
  }
}
