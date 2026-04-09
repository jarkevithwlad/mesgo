import { pullSignalBook, postSignalBook } from './api.js';
import { state, getActiveAccount, getDialogMap, getPeerRuntime, getSelectedPeerGuid } from './state.js';
import { MESSAGE_NAMESPACE, SIGNAL_NAMESPACE, WEBRTC_RETRY_INTERVAL, HANDSHAKE_INTERVAL, nowSeconds, uuidV5, makeSignalBookPath, makeStunBookPath } from './utils.js';
import { ensureDialog, receiveDirectChatMessage, handleMsgAck, retryPendingMessage } from './chats.js';
import { saveState } from './storage.js';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
  ]
};

const hiddenAudioEls = {};

function emitUiRefresh() {
  window.dispatchEvent(new CustomEvent('telegram-ui-refresh'));
}

function getPeerNickname(peerGuid) {
  const dialogs = getDialogMap();
  return dialogs[peerGuid] ? dialogs[peerGuid].peerNickname : 'unknown';
}

/**
 * Получает book path для signal-сообщений пары.
 */
function getStunBookPath(peerGuid) {
  const account = getActiveAccount();
  if (!account) return '';
  return makeStunBookPath(account.guid, peerGuid);
}

async function buildSignalMessage(type, payload) {
  const account = getActiveAccount();
  const timestamp = nowSeconds();

  return {
    guid: (await uuidV5(SIGNAL_NAMESPACE, `${timestamp}|signal|${type}|${Math.random()}`)).toLowerCase(),
    timestamp,
    type,
    from_guid: account.guid,
    from_nickname: account.nickname,
    payload
  };
}

/**
 * Отправляет signal-сообщение в STUN book конкретной пары.
 */
async function sendServerSignal(peerGuid, type, payload = {}) {
  const account = getActiveAccount();
  if (!account) return false;

  const message = await buildSignalMessage(type, payload);
  const bookPath = getStunBookPath(peerGuid);
  if (!bookPath) {
    console.warn('[v2] sendServerSignal: no book path for', peerGuid.slice(0, 8));
    return false;
  }

  try {
    const result = await postSignalBook(account.guid, peerGuid, [message], bookPath);
    if (!result.ok) {
      console.warn('[v2] sendServerSignal HTTP', result.status, 'for', peerGuid.slice(0, 8));
    }
    return result.ok;
  } catch (err) {
    console.warn('[v2] sendServerSignal error:', err.message);
    return false;
  }
}

/**
 * Поллит signal-сообщения из STUN book пары.
 */
async function pullStunBookMessages() {
  const account = getActiveAccount();
  if (!account) return { ok: false, skipped: true };

  const results = [];
  const processedPeerGuids = new Set();
  const processedBooks = new Set();

  // Собираем все активные peerGuid из runtime
  const peerGuids = Object.keys(state.webrtc.byPeerGuid || {});
  if (peerGuids.length === 0) {
    return { ok: true, results: [] };
  }

  for (const peerGuid of peerGuids) {
    const bookPath = getStunBookPath(peerGuid);
    if (!bookPath || processedBooks.has(bookPath)) continue;
    processedBooks.add(bookPath);

    try {
      const result = await pullSignalBook(account.guid, bookPath);
      if (result.ok && result.data && result.data.messages) {
        results.push({ peerGuid, messages: result.data.messages });
      }
    } catch (err) {
      console.warn('[v2] book poll error for', peerGuid.slice(0, 8), ':', err.message);
    }
  }

  return { ok: true, results };
}

function stopPingLoop(peerGuid) {
  const timer = state.webrtc.pingTimers[peerGuid];
  if (timer) {
    clearInterval(timer);
    delete state.webrtc.pingTimers[peerGuid];
  }
}

function startPingLoop(peerGuid) {
  const runtime = getPeerRuntime(peerGuid);
  stopPingLoop(peerGuid);

  runtime.pingMs = null;
  runtime.lastPongAt = 0;

  state.webrtc.pingTimers[peerGuid] = setInterval(() => {
    if (!runtime.dc || runtime.dc.readyState !== 'open') return;

    runtime.lastPingSentAt = Date.now();
    sendDirectPayload(peerGuid, {
      type: 'ping',
      timestampMs: runtime.lastPingSentAt
    }).catch(() => {});
  }, 1000);
}

function setCallEnabled(peerGuid, value) {
  const runtime = getPeerRuntime(peerGuid);
  runtime.callEnabled = Boolean(value);
}

function getAudioElement(peerGuid) {
  let audio = hiddenAudioEls[peerGuid];

  if (!audio) {
    audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.style.display = 'none';
    audio.muted = true;
    document.body.appendChild(audio);
    hiddenAudioEls[peerGuid] = audio;
  }

  return audio;
}

export function setRemoteAudioMuted(peerGuid, muted) {
  const audio = getAudioElement(peerGuid);
  audio.muted = Boolean(muted);
}

function attachRemoteAudio(peerGuid, stream) {
  const audio = getAudioElement(peerGuid);
  audio.srcObject = stream;

  const runtime = getPeerRuntime(peerGuid);
  audio.muted = !runtime.activeCall;
}

async function flushQueuedCandidates(runtime) {
  if (!runtime.pc || !runtime.pc.remoteDescription || !runtime.remoteCandidatesQueue.length) return;

  const queue = [...runtime.remoteCandidatesQueue];
  runtime.remoteCandidatesQueue.length = 0;

  for (const candidate of queue) {
    try {
      await runtime.pc.addIceCandidate(candidate);
    } catch (_) {}
  }
}

function setupDataChannel(peerGuid, dc) {
  const runtime = getPeerRuntime(peerGuid);
  runtime.dc = dc;

  dc.onopen = () => {
    runtime.directReady = true;
    runtime.status = 'connected';
    runtime.statusText = 'Прямое соединение активно';
    runtime.lastHandshakeAt = Date.now();
    runtime.handshakePending = false;
    setCallEnabled(peerGuid, true);
    startPingLoop(peerGuid);
    stopHandshakeLoop(peerGuid);
    emitUiRefresh();
  };

  dc.onclose = () => {
    runtime.directReady = false;
    runtime.status = 'closed';
    runtime.statusText = 'Прямое соединение закрыто';
    runtime.pingMs = null;
    setCallEnabled(peerGuid, false);
    stopPingLoop(peerGuid);
    emitUiRefresh();
  };

  dc.onerror = () => {
    runtime.status = 'error';
    runtime.statusText = 'Ошибка прямого канала';
    emitUiRefresh();
  };

  dc.onmessage = async (event) => {
    try {
      const data = JSON.parse(String(event.data || '{}'));
      await handleDirectPayload(peerGuid, data);
    } catch (_) {}
  };
}

function getTransportType(baseType, directReady) {
  if (directReady) {
    if (baseType === 'offer') return 'signal_offer';
    if (baseType === 'answer') return 'signal_answer';
    if (baseType === 'ice') return 'signal_ice';
  } else {
    if (baseType === 'offer') return 'webrtc_offer';
    if (baseType === 'answer') return 'webrtc_answer';
    if (baseType === 'ice') return 'webrtc_ice_candidate';
  }
  return baseType;
}

async function sendNegotiationMessage(peerGuid, baseType, payload) {
  const runtime = getPeerRuntime(peerGuid);
  const useDirect = Boolean(runtime.dc && runtime.dc.readyState === 'open');
  const type = getTransportType(baseType, useDirect);

  if (useDirect) {
    return sendDirectPayload(peerGuid, {
      type,
      payload
    });
  }

  return sendServerSignal(peerGuid, type, payload);
}

export function getPeerConnection(peerGuid) {
  return getPeerRuntime(peerGuid).pc;
}

/**
 * Создаёт или возвращает PeerConnection.
 * При создании нового PC — сбрасывает все предыдущие состояния.
 */
export async function ensurePeerConnection(peerGuid, peerNickname) {
  const account = getActiveAccount();
  if (!account) return null;

  ensureDialog(peerGuid, peerNickname);

  const runtime = getPeerRuntime(peerGuid);

  // Если уже есть живой PC с open DC — возвращаем его
  if (runtime.pc && runtime.dc && runtime.dc.readyState === 'open') {
    return runtime.pc;
  }

  // Если PC был но DC закрыт — закрываем старый PC полностью
  if (runtime.pc) {
    try {
      runtime.pc.close();
    } catch (_) {}
    runtime.pc = null;
    runtime.dc = null;
    runtime.directReady = false;
    runtime.makingOffer = false;
    runtime.ignoreOffer = false;
  }

  runtime.polite = account.guid.localeCompare(peerGuid) > 0;
  runtime.isInitiator = false;
  runtime.status = 'connecting';
  runtime.statusText = 'Идёт пробитие портов';
  runtime.connectionEpoch = Date.now();

  const pc = new RTCPeerConnection(RTC_CONFIG);
  runtime.pc = pc;

  pc.onicecandidate = async (event) => {
    if (!event.candidate) return;

    try {
      await sendNegotiationMessage(peerGuid, 'ice', {
        candidate: event.candidate
      });
    } catch (_) {}
  };

  pc.onconnectionstatechange = () => {
    const value = pc.connectionState;
    runtime.status = value;

    if (value === 'connected') {
      runtime.statusText = 'Прямое соединение установлено';
      runtime.lastHandshakeAt = Date.now();
      setCallEnabled(peerGuid, true);
    } else if (value === 'connecting') {
      runtime.statusText = 'Идёт пробитие портов';
    } else if (value === 'failed') {
      runtime.statusText = 'Не удалось установить прямую связь';
      runtime.directReady = false;
      runtime.pingMs = null;
      setCallEnabled(peerGuid, false);
    } else if (value === 'disconnected') {
      runtime.statusText = 'Прямая связь потеряна';
      runtime.directReady = false;
      runtime.pingMs = null;
      setCallEnabled(peerGuid, false);
      // Запускаем handshake для восстановления
      ensureHandshakeLoop(peerGuid, peerNickname);
    } else if (value === 'closed') {
      runtime.statusText = 'Соединение закрыто';
      runtime.directReady = false;
      runtime.pingMs = null;
      setCallEnabled(peerGuid, false);
    }

    emitUiRefresh();
  };

  pc.oniceconnectionstatechange = () => {
    const iceState = pc.iceConnectionState;

    if (iceState === 'checking') {
      runtime.statusText = 'Проверка прямого маршрута';
    } else if (iceState === 'connected' || iceState === 'completed') {
      runtime.statusText = 'Прямой маршрут подтверждён';
    } else if (iceState === 'failed') {
      runtime.statusText = 'Не удалось пробить порты';
    }

    emitUiRefresh();
  };

  pc.ondatachannel = (event) => {
    setupDataChannel(peerGuid, event.channel);
  };

  pc.ontrack = (event) => {
    const stream = event.streams && event.streams[0] ? event.streams[0] : null;
    if (!stream) return;

    runtime.remoteStream = stream;
    attachRemoteAudio(peerGuid, stream);
    emitUiRefresh();
  };

  pc.onnegotiationneeded = async () => {
    try {
      runtime.makingOffer = true;
      await pc.setLocalDescription();

      await sendNegotiationMessage(peerGuid, 'offer', {
        sdp: pc.localDescription
      });
    } catch (_) {
      runtime.statusText = 'Ошибка согласования соединения';
      emitUiRefresh();
    } finally {
      runtime.makingOffer = false;
    }
  };

  return pc;
}

export async function initiateDirectPeer(peerGuid, peerNickname) {
  const runtime = getPeerRuntime(peerGuid);
  const pc = await ensurePeerConnection(peerGuid, peerNickname);
  if (!pc) return false;

  if (runtime.dc && runtime.dc.readyState !== 'closed') {
    return true;
  }

  runtime.isInitiator = true;
  runtime.status = 'connecting';
  runtime.statusText = 'Идёт пробитие портов';

  const dc = pc.createDataChannel('chat');
  setupDataChannel(peerGuid, dc);
  emitUiRefresh();
  return true;
}

export async function sendDirectPayload(peerGuid, payload) {
  const runtime = getPeerRuntime(peerGuid);
  if (!runtime.dc || runtime.dc.readyState !== 'open') return false;

  runtime.dc.send(JSON.stringify(payload));
  return true;
}

export async function sendDirectChatPayload(peerGuid, payload) {
  const sent = await sendDirectPayload(peerGuid, payload);
  return sent;
}

async function processNegotiationMessage(peerGuid, messageType, payload, peerNickname) {
  const account = getActiveAccount();
  if (!account) return false;

  const runtime = getPeerRuntime(peerGuid);
  await ensurePeerConnection(peerGuid, peerNickname);
  const pc = runtime.pc;

  if (messageType === 'webrtc_offer' || messageType === 'signal_offer') {
    const offer = payload && payload.sdp ? payload.sdp : null;
    if (!offer) return false;

    const offerCollision = runtime.makingOffer || pc.signalingState !== 'stable';
    runtime.ignoreOffer = !runtime.polite && offerCollision;
    if (runtime.ignoreOffer) return false;

    try {
      await pc.setRemoteDescription(offer);
      await flushQueuedCandidates(runtime);
      await pc.setLocalDescription(await pc.createAnswer());

      await sendNegotiationMessage(peerGuid, 'answer', {
        sdp: pc.localDescription
      });
    } catch (_) {
      runtime.statusText = 'Ошибка обработки offer';
      emitUiRefresh();
      return false;
    }

    runtime.statusText = 'Получен запрос соединения';
    emitUiRefresh();
    return true;
  }

  if (messageType === 'webrtc_answer' || messageType === 'signal_answer') {
    const answer = payload && payload.sdp ? payload.sdp : null;
    if (!answer) return false;

    try {
      await pc.setRemoteDescription(answer);
      await flushQueuedCandidates(runtime);
    } catch (_) {
      runtime.statusText = 'Ошибка обработки answer';
      emitUiRefresh();
      return false;
    }

    runtime.statusText = 'Получен ответ соединения';
    emitUiRefresh();
    return true;
  }

  if (messageType === 'webrtc_ice_candidate' || messageType === 'signal_ice') {
    const candidate = payload && payload.candidate ? payload.candidate : null;
    if (!candidate) return false;

    try {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(candidate);
      } else {
        runtime.remoteCandidatesQueue.push(candidate);
      }
    } catch (_) {}

    await flushQueuedCandidates(runtime);
    return true;
  }

  return false;
}

async function handleDirectPayload(peerGuid, payload) {
  const runtime = getPeerRuntime(peerGuid);
  const peerNickname = getPeerNickname(peerGuid);
  if (!payload || typeof payload !== 'object') return;

  // ACK-механизм для сообщений
  if (payload.type === 'msg_ack' && payload.msg_guid) {
    handleMsgAck(peerGuid, payload.msg_guid);
    emitUiRefresh();
    return;
  }

  if (payload.type === 'chat_message' && payload.message) {
    receiveDirectChatMessage(peerGuid, peerNickname, payload.message);
    runtime.lastDirectMessageAt = Date.now();
    emitUiRefresh();
    return;
  }

  if (payload.type === 'ping') {
    await sendDirectPayload(peerGuid, {
      type: 'pong',
      timestampMs: payload.timestampMs,
      nowMs: Date.now()
    });
    return;
  }

  if (payload.type === 'pong') {
    const sent = Number(payload.timestampMs || 0);
    if (sent) {
      runtime.pingMs = Math.max(0, Date.now() - sent);
      runtime.lastPongAt = Date.now();
      emitUiRefresh();
    }
    return;
  }

  // Handshake mechanism
  if (payload.type === 'handshake_request') {
    runtime.lastHandshakeAt = Date.now();
    runtime.handshakePending = false;

    // Если нет активного соединения — создаём и шлём response
    if (!runtime.directReady || !runtime.pc) {
      await ensurePeerConnection(peerGuid, peerNickname);
      // onnegotiationneeded сам отправит offer
    }

    // Отправляем handshake_response
    await sendDirectPayload(peerGuid, {
      type: 'handshake_response',
      timestampMs: Date.now()
    });
    emitUiRefresh();
    return;
  }

  if (payload.type === 'handshake_response') {
    runtime.lastHandshakeResponseAt = Date.now();
    runtime.handshakePending = false;
    emitUiRefresh();
    return;
  }

  if (
    payload.type === 'signal_offer' ||
    payload.type === 'signal_answer' ||
    payload.type === 'signal_ice'
  ) {
    await processNegotiationMessage(peerGuid, payload.type, payload.payload || {}, peerNickname);
    return;
  }

  if (payload.type && payload.type.startsWith('call_')) {
    const calls = await import('./calls.js');
    await calls.handleDirectCallControl(peerGuid, payload);
    emitUiRefresh();
  }
}

async function handleSignalMessage(message) {
  const account = getActiveAccount();
  if (!account || !message || typeof message !== 'object') return false;
  if (!message.type) return false;

  const peerGuid = String(message.from_guid || '').toLowerCase();
  const peerNickname = String(message.from_nickname || '').trim() || getPeerNickname(peerGuid);
  if (!peerGuid || peerGuid === account.guid) return false;

  const runtime = getPeerRuntime(peerGuid);

  if (message.guid && runtime.seenSignalIds[message.guid]) return false;
  if (message.guid) runtime.seenSignalIds[message.guid] = Date.now();

  if (
    message.type === 'webrtc_offer' ||
    message.type === 'webrtc_answer' ||
    message.type === 'webrtc_ice_candidate' ||
    message.type === 'signal_offer' ||
    message.type === 'signal_answer' ||
    message.type === 'signal_ice'
  ) {
    const handled = await processNegotiationMessage(peerGuid, message.type, message.payload || {}, peerNickname);
    saveState();
    return handled;
  }

  return false;
}

export async function pollSignalServer() {
  const account = getActiveAccount();
  if (!account) return { ok: false, skipped: true };

  let anyChanged = false;

  // 1) Поллим STUN book'и для каждой активной пары (основной путь)
  try {
    const stunResults = await pullStunBookMessages();
    if (stunResults.ok && stunResults.results) {
      for (const { peerGuid, messages } of stunResults.results) {
        const incoming = Array.isArray(messages) ? messages : [];
        for (const item of incoming) {
          const handled = await handleSignalMessage(item);
          anyChanged = anyChanged || handled;
        }
      }
    }
  } catch (err) {
    console.warn('[v2] stun book poll error:', err.message);
  }

  // 2) Поллим default signal endpoint (обратная совместимость)
  try {
    const result = await pullSignalMessages();
    if (result.ok && result.result && result.result.data) {
      const incoming = Array.isArray(result.result.data.messages) ? result.result.data.messages : [];
      for (const item of incoming) {
        const handled = await handleSignalMessage(item);
        anyChanged = anyChanged || handled;
      }
    }
  } catch (err) {
    console.warn('[v2] default signal poll error:', err.message);
  }

  if (anyChanged) {
    saveState();
    emitUiRefresh();
  }

  return { ok: true, changed: anyChanged };
}

// ===== HANDSHAKE MECHANISM =====

export function ensureHandshakeLoop(peerGuid, peerNickname) {
  if (state.webrtc.handshakeTimers[peerGuid]) return;

  console.log('[v2] handshake loop started for', peerGuid.slice(0, 8));

  state.webrtc.handshakeTimers[peerGuid] = setInterval(() => {
    const runtime = getPeerRuntime(peerGuid);
    const selectedPeerGuid = getSelectedPeerGuid();
    const shouldWork = selectedPeerGuid === peerGuid || runtime.callState !== 'idle';

    if (!shouldWork) return;
    if (runtime.directReady) return;
    if (runtime.handshakePending) return;

    console.log('[v2] sending handshake_request to', peerGuid.slice(0, 8));
    // Отправляем handshake_request через сервер
    runtime.handshakePending = true;
    runtime.lastHandshakeSentAt = Date.now();
    sendServerSignal(peerGuid, 'handshake_request', {
      from_guid: getActiveAccount()?.guid,
      timestampMs: Date.now()
    }).then((ok) => {
      console.log('[v2] handshake sent:', ok);
    }).catch((err) => {
      console.warn('[v2] handshake send error:', err.message);
      runtime.handshakePending = false;
    });
  }, HANDSHAKE_INTERVAL);
}

export function stopHandshakeLoop(peerGuid) {
  if (state.webrtc.handshakeTimers[peerGuid]) {
    clearInterval(state.webrtc.handshakeTimers[peerGuid]);
    delete state.webrtc.handshakeTimers[peerGuid];
  }
}

export function ensureRetryLoop(peerGuid, peerNickname) {
  if (state.webrtc.retryTimers[peerGuid]) return;

  state.webrtc.retryTimers[peerGuid] = setInterval(() => {
    const runtime = getPeerRuntime(peerGuid);
    const selectedPeerGuid = getSelectedPeerGuid();
    const shouldWork = selectedPeerGuid === peerGuid || runtime.callState !== 'idle';

    if (!shouldWork) return;
    if (runtime.directReady) return;

    initiateDirectPeer(peerGuid, peerNickname).catch(() => {});
  }, WEBRTC_RETRY_INTERVAL);
}

export function stopRetryLoop(peerGuid) {
  if (state.webrtc.retryTimers[peerGuid]) {
    clearInterval(state.webrtc.retryTimers[peerGuid]);
    delete state.webrtc.retryTimers[peerGuid];
  }
}

export async function ensureDirectForPeer(peerGuid, peerNickname) {
  const runtime = getPeerRuntime(peerGuid);
  console.log('[v2] ensureDirectForPeer', peerGuid.slice(0, 8), 'directReady:', runtime.directReady);

  if (runtime.directReady) return true;

  await initiateDirectPeer(peerGuid, peerNickname);
  ensureRetryLoop(peerGuid, peerNickname);
  ensureHandshakeLoop(peerGuid, peerNickname);
  return true;
}

export function getPeerConnectionStatus(peerGuid) {
  const runtime = getPeerRuntime(peerGuid);

  return {
    status: runtime.status,
    statusText: runtime.statusText,
    pingMs: runtime.directReady ? runtime.pingMs : null,
    directReady: runtime.directReady,
    callEnabled: runtime.callEnabled && runtime.directReady,
    // Статусы доставки pending-сообщений
    pendingMessagesCount: Object.keys(runtime.pendingMessages || {}).length,
    handshakePending: runtime.handshakePending
  };
}

export function clearPeerMedia(peerGuid) {
  const runtime = getPeerRuntime(peerGuid);
  const pc = runtime.pc;

  if (pc) {
    try {
      pc.getSenders().forEach((sender) => {
        if (sender.track && sender.track.kind === 'audio') {
          try {
            pc.removeTrack(sender);
          } catch (_) {}
          try {
            sender.track.stop();
          } catch (_) {}
        }
      });
    } catch (_) {}
  }

  if (runtime.localStream) {
    try {
      runtime.localStream.getTracks().forEach((t) => t.stop());
    } catch (_) {}
    runtime.localStream = null;
  }

  runtime.remoteStream = null;
  runtime.audioEnabled = true;

  const audio = hiddenAudioEls[peerGuid];
  if (audio) {
    audio.muted = true;
    audio.srcObject = null;
  }

  emitUiRefresh();
}

export async function closePeerConnection(peerGuid) {
  const runtime = getPeerRuntime(peerGuid);

  stopPingLoop(peerGuid);
  stopRetryLoop(peerGuid);
  stopHandshakeLoop(peerGuid);
  clearPeerMedia(peerGuid);

  if (runtime.dc) {
    try { runtime.dc.close(); } catch (_) {}
  }

  if (runtime.pc) {
    try { runtime.pc.close(); } catch (_) {}
  }

  if (hiddenAudioEls[peerGuid]) {
    hiddenAudioEls[peerGuid].remove();
    delete hiddenAudioEls[peerGuid];
  }

  clearPeerRuntime(peerGuid);
  emitUiRefresh();
}
