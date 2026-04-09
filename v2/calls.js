import { getActiveAccount, getPeerRuntime } from './state.js';
import { addCallHistoryEntry, formatCallDuration } from './chats.js';
import { clearPeerMedia, ensurePeerConnection, getPeerConnection, sendDirectPayload, setRemoteAudioMuted } from './webrtc.js';

function emitUiRefresh() {
  window.dispatchEvent(new CustomEvent('telegram-ui-refresh'));
}

async function getAudioStream() {
  return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
}

function resolvePeerNickname(peerGuid) {
  const account = getActiveAccount();
  if (!account || !account.dialogs || !account.dialogs[peerGuid]) return 'unknown';
  return account.dialogs[peerGuid].peerNickname || 'unknown';
}

function resetCallState(runtime) {
  runtime.callState = 'idle';
  runtime.incomingCall = false;
  runtime.activeCall = false;
  runtime.currentCallStartedAt = 0;
  runtime.callRole = '';
}

async function attachLocalStream(peerGuid, peerNickname = '') {
  const runtime = getPeerRuntime(peerGuid);

  await ensurePeerConnection(peerGuid, peerNickname || resolvePeerNickname(peerGuid));
  const pc = getPeerConnection(peerGuid);

  if (runtime.localStream) return runtime.localStream;

  const stream = await getAudioStream();
  runtime.localStream = stream;

  stream.getTracks().forEach((track) => {
    const alreadyAdded = pc.getSenders().some((sender) => sender.track === track);
    if (!alreadyAdded) {
      pc.addTrack(track, stream);
    }
  });

  runtime.audioEnabled = true;
  return stream;
}

function getElapsedSec(runtime) {
  if (!runtime.currentCallStartedAt) return 0;
  return Math.max(0, Math.floor((Date.now() - runtime.currentCallStartedAt) / 1000));
}

export function getCallState(peerGuid) {
  const runtime = getPeerRuntime(peerGuid);

  return {
    callState: runtime.callState,
    incomingCall: runtime.incomingCall,
    activeCall: runtime.activeCall,
    audioEnabled: runtime.audioEnabled,
    directReady: runtime.directReady,
    elapsedSec: runtime.activeCall ? getElapsedSec(runtime) : 0,
    elapsedText: runtime.activeCall ? formatCallDuration(getElapsedSec(runtime)) : '00:00'
  };
}

export async function startCall(peerGuid, peerNickname) {
  const runtime = getPeerRuntime(peerGuid);

  await ensurePeerConnection(peerGuid, peerNickname);
  if (!runtime.directReady) {
    throw new Error('Сначала нужно прямое соединение.');
  }

  clearPeerMedia(peerGuid);
  setRemoteAudioMuted(peerGuid, true);

  runtime.callRole = 'out';
  runtime.callState = 'calling';
  runtime.incomingCall = false;
  runtime.activeCall = false;
  runtime.currentCallStartedAt = 0;

  await sendDirectPayload(peerGuid, {
    type: 'call_invite'
  });

  emitUiRefresh();
  return true;
}

export async function acceptIncomingCall(peerGuid, peerNickname) {
  const runtime = getPeerRuntime(peerGuid);

  await ensurePeerConnection(peerGuid, peerNickname);
  await attachLocalStream(peerGuid, peerNickname);

  runtime.callRole = 'in';
  runtime.callState = 'active';
  runtime.incomingCall = false;
  runtime.activeCall = true;
  runtime.currentCallStartedAt = Date.now();

  setRemoteAudioMuted(peerGuid, false);

  await sendDirectPayload(peerGuid, {
    type: 'call_accept'
  });

  emitUiRefresh();
  return true;
}

export async function rejectIncomingCall(peerGuid) {
  const runtime = getPeerRuntime(peerGuid);
  const peerNickname = resolvePeerNickname(peerGuid);

  await addCallHistoryEntry(peerGuid, peerNickname, {
    status: 'rejected',
    durationSec: 0,
    direction: 'in'
  });

  await sendDirectPayload(peerGuid, {
    type: 'call_reject'
  });

  clearPeerMedia(peerGuid);
  resetCallState(runtime);
  emitUiRefresh();
  return true;
}

export async function hangupCall(peerGuid) {
  const runtime = getPeerRuntime(peerGuid);
  const peerNickname = resolvePeerNickname(peerGuid);

  const durationSec = runtime.activeCall ? getElapsedSec(runtime) : 0;
  const direction = runtime.callRole === 'in' ? 'in' : 'out';

  let status = 'canceled';
  if (runtime.activeCall) {
    status = 'ended';
  } else if (runtime.callState === 'incoming') {
    status = 'missed';
  } else if (runtime.callState === 'calling') {
    status = 'canceled';
  }

  await addCallHistoryEntry(peerGuid, peerNickname, {
    status,
    durationSec,
    direction
  });

  await sendDirectPayload(peerGuid, {
    type: 'call_hangup',
    reason: status,
    durationSec
  });

  clearPeerMedia(peerGuid);
  resetCallState(runtime);
  emitUiRefresh();
  return true;
}

export async function toggleMute(peerGuid) {
  const runtime = getPeerRuntime(peerGuid);
  if (!runtime.localStream) return false;

  runtime.audioEnabled = !runtime.audioEnabled;
  runtime.localStream.getAudioTracks().forEach((track) => {
    track.enabled = runtime.audioEnabled;
  });

  await sendDirectPayload(peerGuid, {
    type: runtime.audioEnabled ? 'call_unmute' : 'call_mute'
  });

  emitUiRefresh();
  return runtime.audioEnabled;
}

export async function handleDirectCallControl(peerGuid, payload) {
  const runtime = getPeerRuntime(peerGuid);
  const peerNickname = resolvePeerNickname(peerGuid);
  const type = payload.type;

  if (type === 'call_invite') {
    clearPeerMedia(peerGuid);
    setRemoteAudioMuted(peerGuid, true);

    runtime.callRole = 'in';
    runtime.callState = 'incoming';
    runtime.incomingCall = true;
    runtime.activeCall = false;
    runtime.currentCallStartedAt = 0;

    emitUiRefresh();
    return;
  }

  if (type === 'call_accept') {
    await attachLocalStream(peerGuid, peerNickname);

    runtime.callRole = runtime.callRole || 'out';
    runtime.callState = 'active';
    runtime.incomingCall = false;
    runtime.activeCall = true;
    runtime.currentCallStartedAt = Date.now();

    setRemoteAudioMuted(peerGuid, false);

    emitUiRefresh();
    return;
  }

  if (type === 'call_reject') {
    await addCallHistoryEntry(peerGuid, peerNickname, {
      status: 'rejected',
      durationSec: 0,
      direction: runtime.callRole === 'in' ? 'in' : 'out'
    });

    clearPeerMedia(peerGuid);
    resetCallState(runtime);
    emitUiRefresh();
    return;
  }

  if (type === 'call_hangup') {
    const durationSec = Math.max(
      0,
      Number(payload.durationSec || 0),
      runtime.activeCall ? getElapsedSec(runtime) : 0
    );

    let status = 'missed';
    if (runtime.activeCall || payload.reason === 'ended') {
      status = 'ended';
    } else if (payload.reason === 'canceled') {
      status = runtime.callRole === 'in' ? 'missed' : 'canceled';
    } else if (payload.reason === 'rejected') {
      status = 'rejected';
    } else if (payload.reason === 'missed') {
      status = 'missed';
    }

    await addCallHistoryEntry(peerGuid, peerNickname, {
      status,
      durationSec,
      direction: runtime.callRole === 'in' ? 'in' : 'out'
    });

    clearPeerMedia(peerGuid);
    resetCallState(runtime);
    emitUiRefresh();
    return;
  }

  if (type === 'call_mute') {
    emitUiRefresh();
    return;
  }

  if (type === 'call_unmute') {
    emitUiRefresh();
    return;
  }
}
