import { getActiveAccount, getDialogArray, getSelectedPeerGuid, setSelectedPeerGuid, getPeerRuntime } from './state.js';
import { pullRegularMessages } from './api.js';
import { MESSAGE_NAMESPACE, USER_NAMESPACE, nowSeconds, sanitizeNickname, uuidV5, MSG_ACK_TIMEOUT, MSG_ACK_RETRIES } from './utils.js';
import { saveState, wipeDialogFromStorage } from './storage.js';

let directSender = null;

const CALL_EVENT_PREFIX = '__CALL_EVENT__';

export function registerDirectSender(fn) {
  directSender = typeof fn === 'function' ? fn : null;
}

export function getLastMessage(dialog) {
  return dialog && dialog.messages && dialog.messages.length ? dialog.messages[dialog.messages.length - 1] : null;
}

export function ensureDialog(peerGuid, peerNickname) {
  const account = getActiveAccount();
  if (!account) return null;

  if (!account.dialogs[peerGuid]) {
    account.dialogs[peerGuid] = {
      peerGuid,
      peerNickname: peerNickname || 'unknown',
      unread: 0,
      updatedAt: 0,
      messages: []
    };
  } else if (peerNickname) {
    account.dialogs[peerGuid].peerNickname = peerNickname;
  }

  return account.dialogs[peerGuid];
}

export function dialogHasMessage(dialog, guid) {
  return dialog.messages.some((m) => m.guid === guid);
}

export function addMessageToDialog(peerGuid, peerNickname, messageObj, countUnread = false) {
  const dialog = ensureDialog(peerGuid, peerNickname);
  if (!dialog) return false;
  if (dialogHasMessage(dialog, messageObj.guid)) return false;

  dialog.messages.push(messageObj);
  dialog.messages.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  dialog.updatedAt = Math.max(Number(dialog.updatedAt || 0), Number(messageObj.timestamp || 0));

  if (countUnread && getSelectedPeerGuid() !== peerGuid) {
    dialog.unread = Number(dialog.unread || 0) + 1;
  }

  saveState();
  return true;
}

/**
 * Обновляет статус доставки сообщения в диалоге.
 */
export function updateMessageDeliveryStatus(peerGuid, msgGuid, status) {
  const account = getActiveAccount();
  if (!account || !account.dialogs[peerGuid]) return;

  const dialog = account.dialogs[peerGuid];
  const msg = dialog.messages.find((m) => m.guid === msgGuid);
  if (!msg) return;

  msg.deliveryStatus = status;
  saveState();
}

export async function openDialogByNickname(nickname) {
  const account = getActiveAccount();
  if (!account) {
    throw new Error('Нужен аккаунт.');
  }

  const peerNickname = sanitizeNickname(nickname);
  if (!peerNickname) {
    throw new Error('Укажи nickname.');
  }

  const peerGuid = (await uuidV5(USER_NAMESPACE, peerNickname)).toLowerCase();
  if (peerGuid === account.guid) {
    throw new Error('Нельзя открыть диалог с самим собой.');
  }

  ensureDialog(peerGuid, peerNickname);
  setSelectedPeerGuid(peerGuid);
  saveState();
  return { peerGuid, peerNickname };
}

export function selectDialog(peerGuid) {
  const account = getActiveAccount();
  if (!account || !account.dialogs[peerGuid]) return false;
  account.dialogs[peerGuid].unread = 0;
  setSelectedPeerGuid(peerGuid);
  saveState();
  return true;
}

export function deleteDialog(peerGuid) {
  return wipeDialogFromStorage(peerGuid);
}

export function formatCallDuration(totalSeconds) {
  const sec = Math.max(0, Number(totalSeconds || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;

  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function buildCallEventToken(status, durationSec, direction) {
  return `${CALL_EVENT_PREFIX}|${String(status || 'ended')}|${Math.max(0, Number(durationSec || 0))}|${String(direction || 'out')}`;
}

export function parseCallEventToken(text) {
  const value = String(text || '');
  if (!value.startsWith(`${CALL_EVENT_PREFIX}|`)) return null;

  const parts = value.split('|');
  return {
    kind: 'call',
    status: parts[1] || 'ended',
    durationSec: Math.max(0, Number(parts[2] || 0)),
    direction: parts[3] || 'out'
  };
}

function getCallTitle(meta) {
  if (!meta) return 'Звонок';

  if (meta.status === 'ended') {
    return meta.direction === 'in' ? 'Входящий звонок' : 'Исходящий звонок';
  }

  if (meta.status === 'rejected') {
    return meta.direction === 'in' ? 'Входящий звонок отклонён' : 'Звонок отклонён';
  }

  if (meta.status === 'missed') {
    return meta.direction === 'in' ? 'Пропущенный звонок' : 'Не ответили';
  }

  if (meta.status === 'canceled') {
    return 'Звонок отменён';
  }

  return 'Звонок';
}

function getCallSubtitle(meta) {
  if (!meta) return '';
  if (meta.status === 'ended') {
    return `Длительность ${formatCallDuration(meta.durationSec)}`;
  }
  return 'Без соединения';
}

export function getMessagePresentation(messageObj) {
  const callMeta = parseCallEventToken(messageObj && messageObj.message);
  if (callMeta) {
    return {
      kind: 'call',
      title: getCallTitle(callMeta),
      subtitle: getCallSubtitle(callMeta),
      preview: callMeta.status === 'ended'
        ? `${getCallTitle(callMeta)} · ${formatCallDuration(callMeta.durationSec)}`
        : getCallTitle(callMeta)
    };
  }

  return {
    kind: 'text',
    title: '',
    subtitle: '',
    preview: String((messageObj && messageObj.message) || '')
  };
}

export async function addCallHistoryEntry(peerGuid, peerNickname, payload = {}) {
  const account = getActiveAccount();
  if (!account) return null;

  const timestamp = Number(payload.timestamp || nowSeconds());
  const direction = payload.direction === 'in' ? 'in' : 'out';
  const status = String(payload.status || 'ended');
  const durationSec = Math.max(0, Number(payload.durationSec || 0));
  const messageGuid = (await uuidV5(
    MESSAGE_NAMESPACE,
    `${timestamp}|call|${peerGuid}|${status}|${durationSec}|${direction}|${Math.random()}`
  )).toLowerCase();

  const messageObj = {
    guid: messageGuid,
    message: buildCallEventToken(status, durationSec, direction),
    timestamp,
    from_guid: direction === 'out' ? account.guid : peerGuid,
    from_nickname: direction === 'out' ? account.nickname : peerNickname,
    to_guid: direction === 'out' ? peerGuid : account.guid,
    to_nickname: direction === 'out' ? peerNickname : account.nickname,
    direction,
    deliveryStatus: 'delivered'
  };

  addMessageToDialog(peerGuid, peerNickname, messageObj, false);
  return messageObj;
}

export async function normalizeIncomingMessage(message) {
  const account = getActiveAccount();
  if (!account) return null;
  if (!message || typeof message !== 'object') return null;

  const text = String(message.message || '').trim();
  if (!text) return null;

  const timestamp = Number(message.timestamp) || nowSeconds();
  let guid = String(message.guid || '').trim().toLowerCase();
  if (!guid) {
    guid = await uuidV5(MESSAGE_NAMESPACE, `${timestamp}|${text}`);
  }

  let fromGuid = String(message.from_guid || '').trim().toLowerCase();
  let toGuid = String(message.to_guid || '').trim().toLowerCase();
  const fromNickname = String(message.from_nickname || '').trim();
  const toNickname = String(message.to_nickname || '').trim();

  if (!fromGuid && fromNickname) {
    fromGuid = (await uuidV5(USER_NAMESPACE, fromNickname)).toLowerCase();
  }
  if (!toGuid && toNickname) {
    toGuid = (await uuidV5(USER_NAMESPACE, toNickname)).toLowerCase();
  }

  let peerGuid = '';
  let peerNickname = '';

  if (fromGuid && fromGuid !== account.guid) {
    peerGuid = fromGuid;
    peerNickname = fromNickname || 'unknown';
  } else if (fromNickname && fromNickname !== account.nickname) {
    peerGuid = (await uuidV5(USER_NAMESPACE, fromNickname)).toLowerCase();
    peerNickname = fromNickname;
  } else {
    return null;
  }

  return {
    guid,
    message: text,
    timestamp,
    from_guid: fromGuid,
    from_nickname: fromNickname,
    to_guid: toGuid,
    to_nickname: toNickname,
    direction: 'in',
    peerGuid,
    peerNickname
  };
}

export async function mergeIncomingPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const incoming = Array.isArray(payload.messages) ? payload.messages : [];
  let selectedChanged = false;

  for (const raw of incoming) {
    if (raw && raw.type) continue;

    const message = await normalizeIncomingMessage(raw);
    if (!message) continue;

    const added = addMessageToDialog(
      message.peerGuid,
      message.peerNickname,
      {
        guid: message.guid,
        message: message.message,
        timestamp: message.timestamp,
        from_guid: message.from_guid,
        from_nickname: message.from_nickname,
        to_guid: message.to_guid,
        to_nickname: message.to_nickname,
        direction: 'in',
        deliveryStatus: 'delivered'
      },
      true
    );

    if (added && getSelectedPeerGuid() === message.peerGuid) {
      selectedChanged = true;
    }
  }

  return selectedChanged;
}

export async function pullMessages() {
  const account = getActiveAccount();
  if (!account) return { ok: false, skipped: true };

  const now = Date.now();
  if (Number(account.retryBlockedUntil || 0) > now) {
    return { ok: false, blocked: true };
  }

  let result;
  try {
    result = await pullRegularMessages();
  } catch (err) {
    return { ok: false, error: err.message };
  }

  if (result.ok && result.result && result.result.data) {
    const messages = result.result.data.messages || [];
    let selectedChanged = false;

    for (const item of messages) {
      if (item.type) {
        // Signal message — обрабатываем через WebRTC
        try {
          const { handleSignalMessage } = await import('./webrtc.js');
          await handleSignalMessage(item);
        } catch (_) {}
      } else {
        // Обычное сообщение
        const changed = await mergeIncomingPayload({ messages: [item] });
        selectedChanged = selectedChanged || changed;
      }
    }

    saveState();
    return { ...result, selectedChanged };
  }

  return result;
}

// Re-export pullRegularMessages for compatibility
export { pullRegularMessages } from './api.js';

async function makeMessageGuid(text, peerGuid) {
  return (await uuidV5(MESSAGE_NAMESPACE, `${Date.now()}|${peerGuid}|${text}|${Math.random()}`)).toLowerCase();
}

/**
 * Отправляет сообщение с ACK-механизмом.
 * Если ACK не получен — повторяет отправку с тем же GUID.
 */
export async function sendMessageToPeer(peerGuid, peerNickname, text, options = {}) {
  const account = getActiveAccount();
  const cleanText = String(text || '').trim();
  const preferDirect = options.preferDirect !== false;

  if (!account) {
    throw new Error('Сначала создай аккаунт.');
  }
  if (!peerGuid || !peerNickname) {
    throw new Error('Не выбран получатель.');
  }
  if (!cleanText) {
    throw new Error('Сообщение пустое.');
  }

  const timestamp = nowSeconds();
  const messageGuid = await makeMessageGuid(cleanText, peerGuid);
  const localMessage = {
    guid: messageGuid,
    message: cleanText,
    timestamp,
    from_guid: account.guid,
    from_nickname: account.nickname,
    to_guid: peerGuid,
    to_nickname: peerNickname,
    direction: 'out',
    deliveryStatus: 'pending'
  };

  // Сохраняем в диалог сразу
  addMessageToDialog(peerGuid, peerNickname, localMessage, false);
  setSelectedPeerGuid(peerGuid);
  saveState();

  // Попытка через DataChannel
  if (preferDirect && directSender) {
    const sentDirect = await directSender(peerGuid, {
      type: 'chat_message',
      message: localMessage
    });

    if (sentDirect) {
      // Запускаем ACK-ожидание
      startAckWait(peerGuid, messageGuid, localMessage);
      return { direct: true, message: localMessage };
    }
  }

  // Фоллбэк через сервер (regular endpoint)
  // Используем стандартную отправку сообщений
  try {
    const { sendGenericMessages } = await import('./api.js');
    await sendGenericMessages(peerGuid, [
      {
        guid: messageGuid,
        message: cleanText,
        timestamp,
        from_guid: account.guid,
        from_nickname: account.nickname,
        to_guid: peerGuid,
        to_nickname: peerNickname
      }
    ]);
    updateMessageDeliveryStatus(peerGuid, messageGuid, 'sent');
  } catch (_) {
    updateMessageDeliveryStatus(peerGuid, messageGuid, 'error');
  }

  return { direct: false, message: localMessage };
}

/**
 * Запускает ожидание ACK для сообщения.
 */
function startAckWait(peerGuid, msgGuid, messageObj) {
  const runtime = getPeerRuntime(peerGuid);
  if (!runtime) return;

  runtime.pendingMessages[msgGuid] = {
    payload: { type: 'chat_message', message: messageObj },
    retries: 0,
    messageObj
  };

  updateMessageDeliveryStatus(peerGuid, msgGuid, 'sending');
}

/**
 * Обрабатывает полученный ACK — помечает сообщение доставленным.
 */
export function handleMsgAck(peerGuid, msgGuid) {
  const runtime = getPeerRuntime(peerGuid);
  if (!runtime) return;

  // Отменяем таймер повтора
  const pending = runtime.pendingMessages[msgGuid];
  if (pending) {
    delete runtime.pendingMessages[msgGuid];
  }

  runtime.receivedAckGuids[msgGuid] = true;
  updateMessageDeliveryStatus(peerGuid, msgGuid, 'delivered');
}

/**
 * Повторная отправка сообщения без ACK.
 */
export function retryPendingMessage(peerGuid, msgGuid) {
  const runtime = getPeerRuntime(peerGuid);
  if (!runtime) return;

  const pending = runtime.pendingMessages[msgGuid];
  if (!pending) return;

  if (pending.retries >= MSG_ACK_RETRIES) {
    delete runtime.pendingMessages[msgGuid];
    updateMessageDeliveryStatus(peerGuid, msgGuid, 'error');
    return;
  }

  pending.retries++;
  updateMessageDeliveryStatus(peerGuid, msgGuid, 'retrying');

  // Отправляем с тем же GUID — получатель не создаст дубликат
  if (directSender) {
    directSender(peerGuid, pending.payload).catch(() => {});
  }
}

/**
 * Обрабатывает входящее сообщение и отправляет ACK.
 */
export function receiveDirectChatMessage(peerGuid, peerNickname, messageObj) {
  if (!messageObj || !messageObj.guid || !messageObj.message) return false;

  const msgGuid = String(messageObj.guid).toLowerCase();
  const runtime = getPeerRuntime(peerGuid);

  // Проверяем не дубликат ли это
  if (runtime && runtime.receivedMsgGuids[msgGuid]) {
    // Уже обработали — просто шлём ACK ещё раз
    if (directSender) {
      directSender(peerGuid, { type: 'msg_ack', msg_guid: msgGuid }).catch(() => {});
    }
    return false;
  }

  const normalized = {
    guid: msgGuid,
    message: String(messageObj.message || ''),
    timestamp: Number(messageObj.timestamp || nowSeconds()),
    from_guid: String(messageObj.from_guid || ''),
    from_nickname: String(messageObj.from_nickname || peerNickname || ''),
    to_guid: String(messageObj.to_guid || ''),
    to_nickname: String(messageObj.to_nickname || ''),
    direction: 'in',
    deliveryStatus: 'delivered'
  };

  const added = addMessageToDialog(peerGuid, peerNickname, normalized, true);

  if (added && runtime) {
    runtime.receivedMsgGuids[msgGuid] = true;
  }

  // Отправляем ACK обратно
  if (directSender) {
    directSender(peerGuid, { type: 'msg_ack', msg_guid: msgGuid }).catch(() => {});
  }

  return added;
}

export function getDialogsSummary() {
  return getDialogArray().map((dialog) => ({
    peerGuid: dialog.peerGuid,
    peerNickname: dialog.peerNickname,
    unread: dialog.unread,
    updatedAt: dialog.updatedAt,
    lastMessage: getLastMessage(dialog)
  }));
}
