import { state, STORAGE_KEY } from './state.js';
import { makeId, sanitizeHost, sanitizeNickname, sanitizePath, sanitizePort } from './utils.js';

function normalizeDialogs(dialogsRaw) {
  const normalized = {};

  Object.values(dialogsRaw || {}).forEach((dialog) => {
    if (!dialog || typeof dialog !== 'object') return;

    const peerGuid = String(dialog.peerGuid || '').trim().toLowerCase();
    const peerNickname = String(dialog.peerNickname || '').trim() || 'unknown';
    if (!peerGuid) return;

    const messages = Array.isArray(dialog.messages) ? dialog.messages : [];

    normalized[peerGuid] = {
      peerGuid,
      peerNickname,
      unread: Number(dialog.unread || 0),
      updatedAt: Number(dialog.updatedAt || 0),
      messages: messages
        .map((m) => ({
          guid: String(m.guid || '').trim().toLowerCase(),
          message: String(m.message || ''),
          timestamp: Number(m.timestamp || 0),
          from_guid: String(m.from_guid || ''),
          from_nickname: String(m.from_nickname || ''),
          to_guid: String(m.to_guid || ''),
          to_nickname: String(m.to_nickname || ''),
          direction: String(m.direction || '')
        }))
        .filter((m) => m.guid && m.message)
        .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
    };
  });

  return normalized;
}

function normalizeAccount(acc) {
  const nickname = sanitizeNickname(acc.nickname || '');
  const guid = String(acc.guid || '').toLowerCase();
  if (!nickname || !guid) return null;

  const dialogs = normalizeDialogs(acc.dialogs || {});
  const selectedPeerGuid = String(acc.selectedPeerGuid || '');

  return {
    id: String(acc.id || makeId('acc')),
    nickname,
    guid,
    dialogs,
    selectedPeerGuid: dialogs[selectedPeerGuid] ? selectedPeerGuid : '',
    lastSyncAt: Number(acc.lastSyncAt || 0),
    lastSyncOk: acc.lastSyncOk === null ? null : (typeof acc.lastSyncOk === 'boolean' ? acc.lastSyncOk : null),
    lastError: String(acc.lastError || ''),
    retryBlockedUntil: Number(acc.retryBlockedUntil || 0)
  };
}

export function createAccountObject(nickname, guid) {
  return {
    id: makeId('acc'),
    nickname,
    guid: String(guid).toLowerCase(),
    dialogs: {},
    selectedPeerGuid: '',
    lastSyncAt: 0,
    lastSyncOk: null,
    lastError: '',
    retryBlockedUntil: 0
  };
}

export function normalizeStateAfterLoad() {
  state.connection.host = sanitizeHost(state.connection.host || '127.0.0.1') || '127.0.0.1';
  state.connection.port = sanitizePort(state.connection.port || '3000') || '3000';
  state.connection.path = sanitizePath(state.connection.path || '/messages_v1', '/messages_v1');
  state.connection.stunPath = sanitizePath(state.connection.stunPath || '/messages_v1/stun', '/messages_v1/stun');

  state.accounts = (Array.isArray(state.accounts) ? state.accounts : [])
    .map(normalizeAccount)
    .filter(Boolean);

  if (!state.accounts.find((acc) => acc.id === state.activeAccountId)) {
    state.activeAccountId = state.accounts[0] ? state.accounts[0].id : '';
  }
}

export function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    connection: state.connection,
    accounts: state.accounts,
    activeAccountId: state.activeAccountId
  }));
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      state.firstAccountRequired = true;
      return;
    }

    const data = JSON.parse(raw);

    state.connection = data.connection && typeof data.connection === 'object'
      ? {
          host: String(data.connection.host || '127.0.0.1'),
          port: String(data.connection.port || '3000'),
          path: String(data.connection.path || '/messages_v1'),
          stunPath: String(data.connection.stunPath || '/messages_v1/stun')
        }
      : {
          host: '127.0.0.1',
          port: '3000',
          path: '/messages_v1',
          stunPath: '/messages_v1/stun'
        };

    state.accounts = Array.isArray(data.accounts) ? data.accounts : [];
    state.activeAccountId = String(data.activeAccountId || '');

    normalizeStateAfterLoad();

    if (!state.accounts.length) {
      state.firstAccountRequired = true;
    }
  } catch (_) {
    state.firstAccountRequired = true;
  }
}

export function wipeDialogFromStorage(peerGuid) {
  const account = state.accounts.find((acc) => acc.id === state.activeAccountId);
  if (!account || !peerGuid || !account.dialogs[peerGuid]) return false;

  delete account.dialogs[peerGuid];
  if (account.selectedPeerGuid === peerGuid) {
    account.selectedPeerGuid = '';
  }

  saveState();
  return true;
}
