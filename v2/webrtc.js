import { pullSignalMessages, sendGenericSignal } from './api.js';
import { state, getActiveAccount, getDialogMap, getPeerRuntime, getSelectedPeerGuid } from './state.js';
import { SIGNAL_NAMESPACE, WEBRTC_RETRY_INTERVAL, HANDSHAKE_INTERVAL, nowSeconds, uuidV5 } from './utils.js';
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

async function sendServerSignal(peerGuid, type, payload = {}) {
  const account = getActiveAccount();
  if (!account) return false;
  const message = await buildSignalMessage(type, payload);

  // Всё идёт через один messages endpoint — сервер маршрутизирует по guid
  const { sendGenericMessages } = await import('./api.js');

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const result = await sendGenericMessages(peerGuid, [message]);
      if (result.ok) return true;
      if (result.status === 429) {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
    } catch (err) {
      console.warn('[v2] signal send attempt', attempt + 1, 'failed:', err.message);
    }
    if (attempt < 7) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
  }
  return false;
}

function stopPingLoop(peerGuid) {
  const timer = state.webrtc.pingTimers[peerGuid];
  if (timer) { clearInterval(timer); delete state.webrtc.pingTimers[peerGuid]; }
}

function startPingLoop(peerGuid) {
  const runtime = getPeerRuntime(peerGuid);
  stopPingLoop(peerGuid);
  runtime.pingMs = null;
  runtime.lastPongAt = 0;
  state.webrtc.pingTimers[peerGuid] = setInterval(() => {
    if (!runtime.dc || runtime.dc.readyState !== 'open') return;
    runtime.lastPingSentAt = Date.now();
    sendDirectPayload(peerGuid, { type: 'ping', timestampMs: runtime.lastPingSentAt }).catch(() => {});
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
    audio.autoplay = true; audio.playsInline = true;
    audio.style.display = 'none'; audio.muted = true;
    document.body.appendChild(audio);
    hiddenAudioEls[peerGuid] = audio;
  }
  return audio;
}

export function setRemoteAudioMuted(peerGuid, muted) {
  getAudioElement(peerGuid).muted = Boolean(muted);
}

function attachRemoteAudio(peerGuid, stream) {
  const audio = getAudioElement(peerGuid);
  audio.srcObject = stream;
  audio.muted = !getPeerRuntime(peerGuid).activeCall;
}

async function flushQueuedCandidates(runtime) {
  if (!runtime.pc || !runtime.pc.remoteDescription || !runtime.remoteCandidatesQueue.length) return;
  const queue = [...runtime.remoteCandidatesQueue];
  runtime.remoteCandidatesQueue.length = 0;
  for (const candidate of queue) { try { await runtime.pc.addIceCandidate(candidate); } catch (_) {} }
}

function setupDataChannel(peerGuid, dc) {
  const runtime = getPeerRuntime(peerGuid);
  runtime.dc = dc;
  dc.onopen = () => {
    console.log('[v2] DC open for', peerGuid.slice(0, 8));
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
    try { await handleDirectPayload(peerGuid, JSON.parse(String(event.data || '{}'))); } catch (_) {}
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
  if (useDirect) return sendDirectPayload(peerGuid, { type, payload });

  // Всё через messages endpoint — STUN endpoint не поллится имполит клиентом
  const message = await buildSignalMessage(type, payload);
  const { sendGenericMessages } = await import('./api.js');
  const result = await sendGenericMessages(peerGuid, [message]);
  console.log('[v2] sendNegotiationMessage', type, 'to', peerGuid.slice(0, 8), 'messages:', result.ok, result.status);
  return result.ok;
}

export function getPeerConnection(peerGuid) { return getPeerRuntime(peerGuid).pc; }

/**
 * Закрывает текущий PC и создаёт новый.
 * Вызывается только когда нужно полностью начать заново.
 */
async function recreatePeerConnection(peerGuid, peerNickname) {
  const account = getActiveAccount();
  if (!account) return null;

  const runtime = getPeerRuntime(peerGuid);
  
  // Закрываем старый PC
  if (runtime.pc) {
    try { runtime.pc.close(); } catch (_) {}
  }

  runtime.pc = null;
  runtime.dc = null;
  runtime.directReady = false;
  runtime.makingOffer = false;
  runtime.ignoreOffer = false;
  runtime.seenSignalIds = {};
  runtime.remoteCandidatesQueue = [];
  runtime.minSignalTimestamp = Date.now();
  runtime.negotiationStartedAt = Date.now();
  runtime.polite = account.guid.localeCompare(peerGuid) > 0;
  runtime.status = 'connecting';
  runtime.statusText = 'Идёт пробитие портов';

  console.log('[v2] recreating PC for', peerGuid.slice(0, 8), 'polite:', runtime.polite);

  const pc = new RTCPeerConnection(RTC_CONFIG);
  runtime.pc = pc;

  pc.onicecandidate = async (event) => {
    if (!event.candidate) return;
    try { await sendNegotiationMessage(peerGuid, 'ice', { candidate: event.candidate }); } catch (_) {}
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
    } else if (value === 'disconnected') {
      runtime.statusText = 'Прямая связь потеряна';
      ensureHandshakeLoop(peerGuid, peerNickname);
    }
    emitUiRefresh();
  };

  pc.oniceconnectionstatechange = () => {
    const ice = pc.iceConnectionState;
    if (ice === 'checking') runtime.statusText = 'Проверка прямого маршрута';
    else if (ice === 'connected' || ice === 'completed') runtime.statusText = 'Прямой маршрут подтверждён';
    else if (ice === 'failed') runtime.statusText = 'Не удалось пробить порты';
    emitUiRefresh();
  };

  pc.ondatachannel = (event) => {
    console.log('[v2] ondatachannel for', peerGuid.slice(0, 8));
    setupDataChannel(peerGuid, event.channel);
  };

  pc.ontrack = (event) => {
    const stream = event.streams?.[0];
    if (!stream) return;
    runtime.remoteStream = stream;
    attachRemoteAudio(peerGuid, stream);
    emitUiRefresh();
  };

  pc.onnegotiationneeded = async () => {
    console.log('[v2] onnegotiationneeded for', peerGuid.slice(0, 8));
    try {
      runtime.makingOffer = true;
      await pc.setLocalDescription();
      await sendNegotiationMessage(peerGuid, 'offer', { sdp: pc.localDescription });
    } catch (e) {
      console.warn('[v2] negotiation error:', e.message);
    } finally {
      runtime.makingOffer = false;
    }
  };

  return pc;
}

export async function ensurePeerConnection(peerGuid, peerNickname) {
  const account = getActiveAccount();
  if (!account) return null;
  ensureDialog(peerGuid, peerNickname);

  const runtime = getPeerRuntime(peerGuid);

  // Если DC уже open — всё готово
  if (runtime.pc && runtime.dc && runtime.dc.readyState === 'open') {
    return runtime.pc;
  }

  // Если PC есть и negotiation в процессе — НЕ пересоздаём
  const busyStates = new Set(['have-remote-offer', 'have-local-offer', 'have-local-pranswer', 'have-remote-pranswer']);
  if (runtime.pc && busyStates.has(runtime.pc.signalingState)) {
    return runtime.pc;
  }

  // Если ICE уже connected — НЕ пересоздаём
  if (runtime.pc) {
    const ice = runtime.pc.iceConnectionState;
    if (ice === 'connected' || ice === 'completed') return runtime.pc;
    if (ice === 'checking' || ice === 'new') return runtime.pc; // ждём
  }

  // Если PC есть — закрываем и создаём новый
  return recreatePeerConnection(peerGuid, peerNickname);
}

export async function initiateDirectPeer(peerGuid, peerNickname) {
  const runtime = getPeerRuntime(peerGuid);
  if (runtime.dc && runtime.dc.readyState === 'open') return true;
  if (runtime.pc) return runtime.pc; // PC уже есть, negotiation идёт

  const pc = await recreatePeerConnection(peerGuid, peerNickname);
  if (!pc) return false;

  runtime.isInitiator = true;
  // Только polite клиент создаёт DC
  if (runtime.polite) {
    console.log('[v2] polite: creating DC for', peerGuid.slice(0, 8));
    const dc = pc.createDataChannel('chat');
    setupDataChannel(peerGuid, dc);
  }
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
  return sendDirectPayload(peerGuid, payload);
}

async function processNegotiationMessage(peerGuid, messageType, payload, peerNickname) {
  const account = getActiveAccount();
  if (!account) return false;
  const runtime = getPeerRuntime(peerGuid);
  const pc = await ensurePeerConnection(peerGuid, peerNickname);
  if (!pc) return false;

  if (messageType === 'webrtc_offer' || messageType === 'signal_offer') {
    const offer = payload?.sdp;
    if (!offer) return false;

    // Если DC уже open — соединение уже есть, игнорируем
    if (runtime.dc?.readyState === 'open') return true;

    // Если PC в stable — принимаем offer БЕЗ пересоздания PC
    if (pc.signalingState === 'stable') {
      try {
        await pc.setRemoteDescription(offer);
        await flushQueuedCandidates(runtime);
        await pc.setLocalDescription(await pc.createAnswer());
        await sendNegotiationMessage(peerGuid, 'answer', { sdp: pc.localDescription });
        console.log('[v2] offer accepted on stable PC for', peerGuid.slice(0, 8));
        return true;
      } catch (e) {
        console.warn('[v2] offer on stable failed, recreating PC:', e.message);
        // Только если ошибка — пересоздаём
      }
    }

    // PC нет или ошибка — создаём новый
    await recreatePeerConnection(peerGuid, peerNickname);
    const newPc = runtime.pc;
    if (!newPc) return false;

    try {
      await newPc.setRemoteDescription(offer);
      await flushQueuedCandidates(runtime);
      await newPc.setLocalDescription(await newPc.createAnswer());
      await sendNegotiationMessage(peerGuid, 'answer', { sdp: newPc.localDescription });
      return true;
    } catch (e) {
      console.warn('[v2] offer error:', e.message);
      return false;
    }
  }

  if (messageType === 'webrtc_answer' || messageType === 'signal_answer') {
    const answer = payload?.sdp;
    if (!answer || pc.signalingState !== 'have-local-offer') return false;
    try {
      await pc.setRemoteDescription(answer);
      await flushQueuedCandidates(runtime);
    } catch (e) {
      console.warn('[v2] answer error:', e.message);
      return false;
    }
    return true;
  }

  if (messageType === 'webrtc_ice_candidate' || messageType === 'signal_ice') {
    const candidate = payload?.candidate;
    if (!candidate) return false;
    try {
      if (pc.remoteDescription) await pc.addIceCandidate(candidate);
      else runtime.remoteCandidatesQueue.push(candidate);
    } catch (_) {}
    return true;
  }

  return false;
}

async function handleDirectPayload(peerGuid, payload) {
  const runtime = getPeerRuntime(peerGuid);
  const peerNickname = getPeerNickname(peerGuid);
  if (!payload || typeof payload !== 'object') return;

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
    await sendDirectPayload(peerGuid, { type: 'pong', timestampMs: payload.timestampMs, nowMs: Date.now() });
    return;
  }
  if (payload.type === 'pong') {
    const sent = Number(payload.timestampMs || 0);
    if (sent) { runtime.pingMs = Math.max(0, Date.now() - sent); runtime.lastPongAt = Date.now(); emitUiRefresh(); }
    return;
  }
  if (payload.type === 'handshake_request') {
    runtime.lastHandshakeAt = Date.now();
    runtime.handshakePending = false;

    // Если DC уже open — всё работает
    if (runtime.dc?.readyState === 'open') {
      emitUiRefresh();
      return;
    }

    // ВСЕГДА пересоздаём PC при handshake_request — это гарантия renegotiation
    console.log('[v2] handshake: recreating PC for', peerGuid.slice(0, 8), 'polite:', runtime.polite);
    await recreatePeerConnection(peerGuid, peerNickname);
    const pc = runtime.pc;

    // Отправляем ответ
    await sendServerSignal(peerGuid, 'handshake_response', { timestampMs: Date.now() });

    // Polite клиент сразу шлёт offer
    if (pc && runtime.polite) {
      try {
        runtime.makingOffer = true;
        await pc.setLocalDescription();
        await sendNegotiationMessage(peerGuid, 'offer', { sdp: pc.localDescription });
        console.log('[v2] handshake: polite sent offer for', peerGuid.slice(0, 8));
      } catch (e) {
        console.warn('[v2] handshake offer error:', e.message);
      } finally {
        runtime.makingOffer = false;
      }
    }

    emitUiRefresh();
    return;
  }
  if (message.type === 'handshake_response') {
    const runtime = getPeerRuntime(peerGuid);
    runtime.lastHandshakeResponseAt = Date.now();
    runtime.handshakePending = false;

    if (runtime.dc?.readyState === 'open') return true;

    // Polite клиент: если DC нет — шлём offer
    if (runtime.polite && runtime.pc && (!runtime.dc || runtime.dc.readyState !== 'open')) {
      console.log('[v2] handshake_response: polite sending offer for', peerGuid.slice(0, 8));
      try {
        runtime.makingOffer = true;
        await runtime.pc.setLocalDescription();
        await sendNegotiationMessage(peerGuid, 'offer', { sdp: runtime.pc.localDescription });
      } catch (e) {
        console.warn('[v2] handshake_response offer error:', e.message);
      } finally {
        runtime.makingOffer = false;
      }
    }
    emitUiRefresh();
    return true;
  }
  if (['signal_offer', 'signal_answer', 'signal_ice'].includes(payload.type)) {
    await processNegotiationMessage(peerGuid, payload.type, payload.payload || {}, peerNickname);
    return;
  }
  if (payload.type?.startsWith('call_')) {
    const calls = await import('./calls.js');
    await calls.handleDirectCallControl(peerGuid, payload);
    emitUiRefresh();
  }
}

export async function handleSignalMessage(message) {
  const account = getActiveAccount();
  if (!account || !message?.type) return false;
  const peerGuid = String(message.from_guid || '').toLowerCase();
  const peerNickname = String(message.from_nickname || '').trim() || getPeerNickname(peerGuid);
  if (!peerGuid || peerGuid === account.guid) return false;
  const runtime = getPeerRuntime(peerGuid);

  if (message.guid && runtime.seenSignalIds[message.guid]) return false;
  if (message.guid) runtime.seenSignalIds[message.guid] = Date.now();

  // Stale ICE filter
  const msgTs = Number(message.timestamp || 0) * 1000;
  if (['webrtc_ice_candidate', 'signal_ice'].includes(message.type) &&
      runtime.minSignalTimestamp && msgTs > 0 && msgTs < runtime.minSignalTimestamp) {
    return false;
  }

  if (['webrtc_offer', 'webrtc_answer', 'webrtc_ice_candidate', 'signal_offer', 'signal_answer', 'signal_ice'].includes(message.type)) {
    return processNegotiationMessage(peerGuid, message.type, message.payload || {}, peerNickname);
  }
  if (message.type === 'handshake_request') {
    console.log('[v2] handshake_request from', peerGuid.slice(0, 8));
    const pc = await ensurePeerConnection(peerGuid, peerNickname);
    // Ответим через DataChannel когда откроется
    return true;
  }
  return false;
}

export async function pollSignalServer() {
  const account = getActiveAccount();
  if (!account) return { ok: false, skipped: true };
  let anyChanged = false;

  // Поллим messages endpoint — server маршрутизирует signal сообщения туда же
  try {
    const { pullRegularMessages } = await import('./api.js');
    const result = await pullRegularMessages();
    if (result.ok && result.result?.data) {
      const messages = result.result.data.messages || [];
      for (const item of messages) {
        if (item.type) { // signal message
          anyChanged = anyChanged || await handleSignalMessage(item);
        }
      }
    }
  } catch (err) {
    console.warn('[v2] messages poll error:', err.message);
  }

  if (anyChanged) { saveState(); emitUiRefresh(); }
  return { ok: true, changed: anyChanged };
}

// ===== HANDSHAKE =====

export function ensureHandshakeLoop(peerGuid, peerNickname) {
  if (state.webrtc.handshakeTimers[peerGuid]) return;
  state.webrtc.handshakeTimers[peerGuid] = setInterval(() => {
    const runtime = getPeerRuntime(peerGuid);
    if (!runtime) return;
    const selectedPeerGuid = getSelectedPeerGuid();
    if (runtime.directReady) return;
    if (selectedPeerGuid !== peerGuid && runtime.callState === 'idle') return;
    if (runtime.handshakePending) return;

    runtime.handshakePending = true;
    runtime.lastHandshakeSentAt = Date.now();
    sendServerSignal(peerGuid, 'handshake_request', { timestampMs: Date.now() })
      .then(ok => { if (!ok) runtime.handshakePending = false; })
      .catch(() => { runtime.handshakePending = false; });
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
    if (!runtime || runtime.directReady) return;
    const selectedPeerGuid = getSelectedPeerGuid();
    if (selectedPeerGuid !== peerGuid && runtime.callState === 'idle') return;
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
  if (runtime.directReady) return true;
  await initiateDirectPeer(peerGuid, peerNickname);
  ensureRetryLoop(peerGuid, peerNickname);
  ensureHandshakeLoop(peerGuid, peerNickname);
  return true;
}

export function getPeerConnectionStatus(peerGuid) {
  const r = getPeerRuntime(peerGuid);
  return {
    status: r.status, statusText: r.statusText,
    pingMs: r.directReady ? r.pingMs : null,
    directReady: r.directReady,
    callEnabled: r.callEnabled && r.directReady,
    pendingMessagesCount: Object.keys(r.pendingMessages || {}).length,
    handshakePending: r.handshakePending
  };
}

export function clearPeerMedia(peerGuid) {
  const runtime = getPeerRuntime(peerGuid);
  const pc = runtime.pc;
  if (pc) {
    try {
      pc.getSenders().forEach(s => {
        if (s.track?.kind === 'audio') { try { pc.removeTrack(s); s.track.stop(); } catch (_) {} }
      });
    } catch (_) {}
  }
  if (runtime.localStream) {
    try { runtime.localStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    runtime.localStream = null;
  }
  runtime.remoteStream = null;
  runtime.audioEnabled = true;
  const audio = hiddenAudioEls[peerGuid];
  if (audio) { audio.muted = true; audio.srcObject = null; }
  emitUiRefresh();
}

export async function closePeerConnection(peerGuid) {
  const runtime = getPeerRuntime(peerGuid);
  stopPingLoop(peerGuid);
  stopRetryLoop(peerGuid);
  stopHandshakeLoop(peerGuid);
  clearPeerMedia(peerGuid);
  if (runtime.dc) { try { runtime.dc.close(); } catch (_) {} }
  if (runtime.pc) { try { runtime.pc.close(); } catch (_) {} }
  if (hiddenAudioEls[peerGuid]) { hiddenAudioEls[peerGuid].remove(); delete hiddenAudioEls[peerGuid]; }
  const { clearPeerRuntime } = await import('./state.js');
  clearPeerRuntime(peerGuid);
  emitUiRefresh();
}
