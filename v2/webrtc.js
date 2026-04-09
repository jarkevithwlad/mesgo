import { pullSignalMessages, sendGenericSignal } from './api.js';
import { state, getActiveAccount, getDialogMap, getPeerRuntime, getSelectedPeerGuid } from './state.js';
import { SIGNAL_NAMESPACE, WEBRTC_RETRY_INTERVAL, HANDSHAKE_INTERVAL, nowSeconds, uuidV5, SESSION_ID } from './utils.js';
import { ensureDialog, receiveDirectChatMessage, handleMsgAck, retryPendingMessage } from './chats.js';
import { saveState } from './storage.js';

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

const hiddenAudioEls = {};
function emitUiRefresh() { window.dispatchEvent(new CustomEvent('telegram-ui-refresh')); }
function getPeerNickname(pg) { const d = getDialogMap(); return d[pg] ? d[pg].peerNickname : 'unknown'; }

async function buildSignalMessage(type, payload) {
  const account = getActiveAccount();
  const ts = nowSeconds();
  return {
    guid: (await uuidV5(SIGNAL_NAMESPACE, `${ts}|signal|${type}|${Math.random()}`)).toLowerCase(),
    timestamp: ts, type,
    from_guid: account.guid, from_nickname: account.nickname,
    session_id: SESSION_ID,
    payload
  };
}

async function sendServerSignal(peerGuid, type, payload = {}) {
  const account = getActiveAccount();
  if (!account) return false;
  const message = await buildSignalMessage(type, payload);
  try {
    const { sendGenericMessages } = await import('./api.js');
    const result = await sendGenericMessages(peerGuid, [message]);
    return result.ok;
  } catch (e) {
    console.warn('[v2] signal send error:', e.message);
    return false;
  }
}

function stopPingLoop(pg) {
  const t = state.webrtc.pingTimers[pg];
  if (t) { clearInterval(t); delete state.webrtc.pingTimers[pg]; }
}
function startPingLoop(pg) {
  const r = getPeerRuntime(pg);
  stopPingLoop(pg);
  r.pingMs = null; r.lastPongAt = 0;
  state.webrtc.pingTimers[pg] = setInterval(() => {
    if (!r.dc || r.dc.readyState !== 'open') return;
    r.lastPingSentAt = Date.now();
    sendDirectPayload(pg, { type: 'ping', timestampMs: r.lastPingSentAt }).catch(() => {});
  }, 1000);
}
function setCallEnabled(pg, v) { getPeerRuntime(pg).callEnabled = Boolean(v); }

function getAudioElement(pg) {
  let a = hiddenAudioEls[pg];
  if (!a) {
    a = document.createElement('audio');
    a.autoplay = true; a.playsInline = true; a.style.display = 'none'; a.muted = true;
    document.body.appendChild(a); hiddenAudioEls[pg] = a;
  }
  return a;
}
export function setRemoteAudioMuted(pg, m) { getAudioElement(pg).muted = Boolean(m); }
function attachRemoteAudio(pg, stream) {
  const a = getAudioElement(pg); a.srcObject = stream;
  a.muted = !getPeerRuntime(pg).activeCall;
}

async function flushQueuedCandidates(r) {
  if (!r.pc || !r.pc.remoteDescription || !r.remoteCandidatesQueue.length) return;
  const q = [...r.remoteCandidatesQueue]; r.remoteCandidatesQueue.length = 0;
  for (const c of q) { try { await r.pc.addIceCandidate(c); } catch (_) {} }
}

function setupDataChannel(pg, dc) {
  const r = getPeerRuntime(pg);
  r.dc = dc;
  dc.onopen = () => {
    console.log('[v2] DC open for', pg.slice(0, 8));
    r.directReady = true; r.status = 'connected';
    r.statusText = 'Прямое соединение активно';
    r.lastHandshakeAt = Date.now(); r.handshakePending = false;
    setCallEnabled(pg, true); startPingLoop(pg);
    stopHandshakeLoop(pg); stopRetryLoop(pg);
    emitUiRefresh();
  };
  dc.onclose = () => {
    r.directReady = false; r.status = 'closed';
    r.statusText = 'Прямое соединение закрыто';
    r.pingMs = null; setCallEnabled(pg, false); stopPingLoop(pg);
    emitUiRefresh();
  };
  dc.onerror = () => { r.status = 'error'; r.statusText = 'Ошибка прямого канала'; emitUiRefresh(); };
  dc.onmessage = async (ev) => {
    try { await handleDirectPayload(pg, JSON.parse(String(ev.data || '{}'))); } catch (_) {}
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

async function sendNegotiationMessage(pg, baseType, payload) {
  const r = getPeerRuntime(pg);
  const useDirect = Boolean(r.dc && r.dc.readyState === 'open');
  const type = getTransportType(baseType, useDirect);
  if (useDirect) return sendDirectPayload(pg, { type, payload });
  const message = await buildSignalMessage(type, payload);
  const { sendGenericMessages } = await import('./api.js');
  const result = await sendGenericMessages(pg, [message]);
  console.log('[v2] sendNegotiationMessage', type, 'to', pg.slice(0, 8), ':', result.ok, result.status);
  return result.ok;
}

export { _ensurePeerConnection as ensurePeerConnection, destroyPC };
export function getPeerConnection(pg) { return getPeerRuntime(pg).pc; }

function destroyPC(pg) {
  const r = getPeerRuntime(pg);
  if (r.pc) { try { r.pc.close(); } catch (_) {} }
  r.pc = null; r.dc = null; r.directReady = false;
  r.makingOffer = false; r.ignoreOffer = false;
  r.seenSignalIds = {}; r.remoteCandidatesQueue = [];
  r.negotiationStartedAt = 0;
}

/**
 * Создаёт или возвращает PC. Если PC уже есть и negotiation идёт — возвращает его.
 */
async function _ensurePeerConnection(pg, nickname) {
  const account = getActiveAccount();
  if (!account) return null;
  ensureDialog(pg, nickname);
  const r = getPeerRuntime(pg);

  // DC open — готово
  if (r.pc && r.dc && r.dc.readyState === 'open') return r.pc;

  // Negotiation в процессе — не трогаем
  const busy = new Set(['have-remote-offer', 'have-local-offer', 'have-local-pranswer', 'have-remote-pranswer']);
  if (r.pc && busy.has(r.pc.signalingState)) return r.pc;

  // ICE connected — не трогаем
  if (r.pc) {
    const ice = r.pc.iceConnectionState;
    if (ice === 'connected' || ice === 'completed' || ice === 'checking') return r.pc;
  }

  // Уничтожаем старый и создаём новый
  destroyPC(pg);
  r.polite = account.guid.localeCompare(pg) > 0;
  r.status = 'connecting'; r.statusText = 'Идёт пробитие портов';
  r.connectionEpoch = Date.now(); r.negotiationStartedAt = Date.now();
  r.minSignalTimestamp = Date.now();

  console.log('[v2] creating PC for', pg.slice(0, 8), 'polite:', r.polite);

  const pc = new RTCPeerConnection(RTC_CONFIG);
  r.pc = pc;

  pc.onicecandidate = async (ev) => {
    if (!ev.candidate) return;
    try { await sendNegotiationMessage(pg, 'ice', { candidate: ev.candidate }); } catch (_) {}
  };
  pc.onconnectionstatechange = () => {
    const v = pc.connectionState; r.status = v;
    if (v === 'connected') { r.statusText = 'Прямое соединение установлено'; r.lastHandshakeAt = Date.now(); setCallEnabled(pg, true); }
    else if (v === 'connecting') { r.statusText = 'Идёт пробитие портов'; }
    else if (v === 'failed') { r.statusText = 'Не удалось установить прямую связь'; }
    else if (v === 'disconnected') { r.statusText = 'Прямая связь потеряна'; ensureHandshakeLoop(pg, nickname); }
    else if (v === 'closed') { r.statusText = 'Соединение закрыто'; }
    emitUiRefresh();
  };
  pc.oniceconnectionstatechange = () => {
    const ice = pc.iceConnectionState;
    if (ice === 'checking') r.statusText = 'Проверка прямого маршрута';
    else if (ice === 'connected' || ice === 'completed') r.statusText = 'Прямой маршрут подтверждён';
    else if (ice === 'failed') r.statusText = 'Не удалось пробить порты';
    emitUiRefresh();
  };
  pc.ondatachannel = (ev) => {
    console.log('[v2] ondatachannel for', pg.slice(0, 8));
    setupDataChannel(pg, ev.channel);
  };
  pc.ontrack = (ev) => {
    const s = ev.streams?.[0]; if (!s) return;
    r.remoteStream = s; attachRemoteAudio(pg, s); emitUiRefresh();
  };
  pc.onnegotiationneeded = async () => {
    // Только polite клиент инициирует negotiation
    if (!r.polite) {
      console.log('[v2] onnegotiationneeded ignored (impolite) for', pg.slice(0, 8));
      return;
    }
    console.log('[v2] onnegotiationneeded for', pg.slice(0, 8));
    try {
      r.makingOffer = true;
      await pc.setLocalDescription();
      await sendNegotiationMessage(pg, 'offer', { sdp: pc.localDescription });
    } catch (e) { console.warn('[v2] negotiation error:', e.message); }
    finally { r.makingOffer = false; }
  };

  return pc;
}

export async function initiateDirectPeer(pg, nickname) {
  const r = getPeerRuntime(pg);
  if (r.dc && r.dc.readyState === 'open') return true;
  if (r.pc) {
    // Только polite клиент создаёт DC
    if (r.polite && (!r.dc || r.dc.readyState === 'closed')) {
      const dc = r.pc.createDataChannel('chat');
      setupDataChannel(pg, dc);
    }
    return r.pc;
  }
  const pc = await _ensurePeerConnection(pg, nickname);
  if (!pc) return false;
  r.isInitiator = true; r.status = 'connecting'; r.statusText = 'Идёт пробитие портов';
  // Только polite клиент создаёт DC — onnegotiationneeded сам отправит offer
  if (r.polite) {
    const dc = pc.createDataChannel('chat');
    setupDataChannel(pg, dc);
  }
  emitUiRefresh();
  return true;
}

export async function sendDirectPayload(pg, payload) {
  const r = getPeerRuntime(pg);
  if (!r.dc || r.dc.readyState !== 'open') return false;
  r.dc.send(JSON.stringify(payload)); return true;
}
export async function sendDirectChatPayload(pg, payload) { return sendDirectPayload(pg, payload); }

async function processNegotiationMessage(pg, messageType, payload, nickname) {
  const account = getActiveAccount();
  if (!account) return false;
  const r = getPeerRuntime(pg);
  const pc = await _ensurePeerConnection(pg, nickname);
  if (!pc) return false;

  if (messageType === 'webrtc_offer' || messageType === 'signal_offer') {
    const offer = payload?.sdp;
    if (!offer) return false;
    if (r.dc?.readyState === 'open') return true;

    // Если PC в stable — принимаем offer
    if (pc.signalingState === 'stable') {
      try {
        await pc.setRemoteDescription(offer);
        await flushQueuedCandidates(r);
        await pc.setLocalDescription(await pc.createAnswer());
        await sendNegotiationMessage(pg, 'answer', { sdp: pc.localDescription });
        console.log('[v2] offer accepted for', pg.slice(0, 8));
        return true;
      } catch (e) {
        console.warn('[v2] offer accept error:', e.message);
        destroyPC(pg);
      }
    }

    // PC не в stable — пересоздаём и пробуем снова
    destroyPC(pg);
    const newPc = await _ensurePeerConnection(pg, nickname);
    if (!newPc) return false;
    try {
      await newPc.setRemoteDescription(offer);
      await flushQueuedCandidates(r);
      await newPc.setLocalDescription(await newPc.createAnswer());
      await sendNegotiationMessage(pg, 'answer', { sdp: newPc.localDescription });
      return true;
    } catch (e) { console.warn('[v2] offer error after recreate:', e.message); }
    return false;
  }

  if (messageType === 'webrtc_answer' || messageType === 'signal_answer') {
    const answer = payload?.sdp;
    if (!answer) return false;
    if (pc.signalingState !== 'have-local-offer') {
      console.log('[v2] ignoring answer, state:', pc.signalingState);
      return false;
    }
    try {
      await pc.setRemoteDescription(answer);
      await flushQueuedCandidates(r);
      console.log('[v2] answer set for', pg.slice(0, 8));
      return true;
    } catch (e) { console.warn('[v2] answer error:', e.message); }
    return false;
  }

  if (messageType === 'webrtc_ice_candidate' || messageType === 'signal_ice') {
    const candidate = payload?.candidate;
    if (!candidate) return false;
    try {
      if (pc.remoteDescription) await pc.addIceCandidate(candidate);
      else r.remoteCandidatesQueue.push(candidate);
    } catch (_) {}
    return true;
  }
  return false;
}

async function handleDirectPayload(pg, payload) {
  const nickname = getPeerNickname(pg);
  if (!payload || typeof payload !== 'object') return;
  const r = getPeerRuntime(pg);

  if (payload.type === 'msg_ack' && payload.msg_guid) { handleMsgAck(pg, payload.msg_guid); emitUiRefresh(); return; }
  if (payload.type === 'chat_message' && payload.message) {
    receiveDirectChatMessage(pg, nickname, payload.message);
    r.lastDirectMessageAt = Date.now(); emitUiRefresh(); return;
  }
  if (payload.type === 'ping') {
    await sendDirectPayload(pg, { type: 'pong', timestampMs: payload.timestampMs, nowMs: Date.now() }); return;
  }
  if (payload.type === 'pong') {
    const s = Number(payload.timestampMs || 0);
    if (s) { r.pingMs = Math.max(0, Date.now() - s); r.lastPongAt = Date.now(); emitUiRefresh(); }
    return;
  }
  if (payload.type?.startsWith('call_')) {
    const calls = await import('./calls.js');
    await calls.handleDirectCallControl(pg, payload); emitUiRefresh();
  }
}

export async function handleSignalMessage(message) {
  const account = getActiveAccount();
  if (!account || !message?.type) return false;
  const pg = String(message.from_guid || '').toLowerCase();
  const nickname = String(message.from_nickname || '').trim() || getPeerNickname(pg);
  if (!pg || pg === account.guid) return false;
  const r = getPeerRuntime(pg);

  // Фильтрация по sessionId — игнорируем сообщения от старых сессий
  if (message.session_id && r.lastSeenSessionId && message.session_id !== r.lastSeenSessionId) {
    // Новая сессия — сбрасываем всё и обновляем
    console.log('[v2] session changed for', pg.slice(0, 8), message.session_id.slice(0, 8));
    destroyPC(pg);
    r.lastSeenSessionId = message.session_id;
  }
  if (message.session_id && !r.lastSeenSessionId) {
    r.lastSeenSessionId = message.session_id;
  }

  if (message.guid && r.seenSignalIds[message.guid]) return false;
  if (message.guid) r.seenSignalIds[message.guid] = Date.now();

  if (['webrtc_offer', 'webrtc_answer', 'webrtc_ice_candidate', 'signal_offer', 'signal_answer', 'signal_ice'].includes(message.type)) {
    return processNegotiationMessage(pg, message.type, message.payload || {}, nickname);
  }
  return false;
}

export async function pollSignalServer() {
  const account = getActiveAccount();
  if (!account) return { ok: false, skipped: true };
  let anyChanged = false;
  try {
    const { pullRegularMessages } = await import('./api.js');
    const result = await pullRegularMessages();
    if (result.ok && result.result?.data) {
      for (const item of (result.result.data.messages || [])) {
        if (item.type) anyChanged = anyChanged || await handleSignalMessage(item);
      }
    }
  } catch (err) { console.warn('[v2] poll error:', err.message); }
  if (anyChanged) { saveState(); emitUiRefresh(); }
  return { ok: true, changed: anyChanged };
}

// ===== HANDSHAKE =====

export function ensureHandshakeLoop(pg, nickname) {
  if (state.webrtc.handshakeTimers[pg]) return;
  state.webrtc.handshakeTimers[pg] = setInterval(() => {
    const r = getPeerRuntime(pg);
    if (!r || r.directReady) return;
    const sel = getSelectedPeerGuid();
    if (sel !== pg && r.callState === 'idle') return;

    // Если PC есть и ICE в процессе или negotiation идёт — НЕ трогаем
    if (r.pc) {
      const ice = r.pc.iceConnectionState;
      if (ice === 'checking' || ice === 'connected' || ice === 'completed') return;
      const busy = new Set(['have-remote-offer', 'have-local-offer', 'have-local-pranswer', 'have-remote-pranswer']);
      if (busy.has(r.pc.signalingState)) return;
      // Если PC создан менее 10 сек назад — ждём
      if (r.negotiationStartedAt && (Date.now() - r.negotiationStartedAt) < 10000) return;
    }

    // Только polite клиент пересоздаёт PC и шлёт offer
    if (!r.handshakePending && r.polite) {
      r.handshakePending = true;
      console.log('[v2] handshake: recreating PC for', pg.slice(0, 8));
      destroyPC(pg);
      _ensurePeerConnection(pg, nickname).then(pc => {
        r.handshakePending = false;
      }).catch(() => { r.handshakePending = false; });
    }
  }, HANDSHAKE_INTERVAL);
}

export function stopHandshakeLoop(pg) {
  if (state.webrtc.handshakeTimers[pg]) {
    clearInterval(state.webrtc.handshakeTimers[pg]);
    delete state.webrtc.handshakeTimers[pg];
  }
}

export function ensureRetryLoop(pg, nickname) {
  if (state.webrtc.retryTimers[pg]) return;
  state.webrtc.retryTimers[pg] = setInterval(() => {
    const r = getPeerRuntime(pg);
    if (!r || r.directReady) return;
    if (getSelectedPeerGuid() !== pg && r.callState === 'idle') return;
    initiateDirectPeer(pg, nickname).catch(() => {});
  }, WEBRTC_RETRY_INTERVAL);
}

export function stopRetryLoop(pg) {
  if (state.webrtc.retryTimers[pg]) {
    clearInterval(state.webrtc.retryTimers[pg]);
    delete state.webrtc.retryTimers[pg];
  }
}

export async function ensureDirectForPeer(pg, nickname) {
  const r = getPeerRuntime(pg);
  if (r.directReady) return true;
  await initiateDirectPeer(pg, nickname);
  ensureRetryLoop(pg, nickname);
  ensureHandshakeLoop(pg, nickname);
  return true;
}

export function getPeerConnectionStatus(pg) {
  const r = getPeerRuntime(pg);
  return {
    status: r.status, statusText: r.statusText,
    pingMs: r.directReady ? r.pingMs : null,
    directReady: r.directReady,
    callEnabled: r.callEnabled && r.directReady,
    pendingMessagesCount: Object.keys(r.pendingMessages || {}).length,
    handshakePending: r.handshakePending
  };
}

export function clearPeerMedia(pg) {
  const r = getPeerRuntime(pg);
  if (r.pc) { try { r.pc.getSenders().forEach(s => { if (s.track?.kind === 'audio') { try { r.pc.removeTrack(s); s.track.stop(); } catch (_) {} } }); } catch (_) {} }
  if (r.localStream) { try { r.localStream.getTracks().forEach(t => t.stop()); } catch (_) {} r.localStream = null; }
  r.remoteStream = null; r.audioEnabled = true;
  const a = hiddenAudioEls[pg]; if (a) { a.muted = true; a.srcObject = null; }
  emitUiRefresh();
}

export async function closePeerConnection(pg) {
  const r = getPeerRuntime(pg);
  stopPingLoop(pg); stopRetryLoop(pg); stopHandshakeLoop(pg);
  clearPeerMedia(pg);
  if (r.dc) { try { r.dc.close(); } catch (_) {} }
  if (r.pc) { try { r.pc.close(); } catch (_) {} }
  if (hiddenAudioEls[pg]) { hiddenAudioEls[pg].remove(); delete hiddenAudioEls[pg]; }
  const { clearPeerRuntime } = await import('./state.js');
  clearPeerRuntime(pg); emitUiRefresh();
}
