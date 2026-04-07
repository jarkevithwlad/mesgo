import { getActiveAccount, getEndpoint } from './state.js';
import { parseRetryAfter } from './utils.js';

export async function postJSON(url, payload, timeout = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const text = await response.text();
    let data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        throw new Error('Сервер вернул невалидный JSON');
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      data,
      headers: response.headers
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function postMessages(payload, timeout = 6000) {
  const endpoint = getEndpoint('messages');
  if (!endpoint) throw new Error('Не задан endpoint сообщений');
  return postJSON(endpoint, payload, timeout);
}

export async function postSignal(payload, timeout = 6000) {
  const endpoint = getEndpoint('stun');
  if (!endpoint) throw new Error('Не задан endpoint signal/stun');
  return postJSON(endpoint, payload, timeout);
}

export async function pullRegularMessages() {
  const account = getActiveAccount();
  if (!account) return { ok: false, skipped: true };

  const result = await postMessages({ guid: account.guid }, 6000);

  if (result.status === 429) {
    const retrySeconds = parseRetryAfter(result.headers) || 2;
    account.retryBlockedUntil = Date.now() + retrySeconds * 1000;
    account.lastSyncOk = false;
    account.lastError = `429, ждать ${retrySeconds} сек.`;
    return { ok: false, throttled: true, retrySeconds, result };
  }

  if (result.status === 404 && result.data && result.data.error === 'guid not found') {
    account.lastSyncOk = true;
    account.lastError = '';
    account.lastSyncAt = Date.now();
    return { ok: true, empty: true, result };
  }

  if (!result.ok) {
    throw new Error(result.data && result.data.error ? result.data.error : `HTTP ${result.status}`);
  }

  account.lastSyncOk = true;
  account.lastError = '';
  account.lastSyncAt = Date.now();
  return { ok: true, result };
}

export async function pullSignalMessages() {
  const account = getActiveAccount();
  if (!account) return { ok: false, skipped: true };

  const result = await postSignal({ guid: account.guid }, 6000);

  if (result.status === 404 && result.data && result.data.error === 'guid not found') {
    return { ok: true, empty: true, result };
  }

  if (!result.ok) {
    throw new Error(result.data && result.data.error ? result.data.error : `HTTP ${result.status}`);
  }

  return { ok: true, result };
}

export async function sendGenericMessages(peerGuid, messages) {
  return postMessages({ guid: peerGuid, messages }, 6000);
}

export async function sendGenericSignal(peerGuid, messages) {
  return postSignal({ guid: peerGuid, messages }, 6000);
}
