import { createExtraAccount, createInitialAccount, deleteAccount, switchAccount } from './accounts.js';
import {
  deleteDialog,
  formatCallDuration,
  getDialogsSummary,
  getMessagePresentation,
  openDialogByNickname,
  selectDialog,
  sendMessageToPeer
} from './chats.js';
import { acceptIncomingCall, getCallState, hangupCall, rejectIncomingCall, startCall, toggleMute } from './calls.js';
import { getActiveAccount, getSelectedDialog, getSelectedPeerGuid, state } from './state.js';
import { copyText, escapeHtml, formatDateChip, formatTime, getInitial, SCROLL_BOTTOM_THRESHOLD, shortGuid } from './utils.js';
import { saveState } from './storage.js';
import { ensureDirectForPeer, getPeerConnectionStatus } from './webrtc.js';

export const els = {};

function q(id) {
  return document.getElementById(id);
}

export function initUi() {
  Object.assign(els, {
    settingsBtn: q('settingsBtn'),
    closeSettingsBtn: q('closeSettingsBtn'),
    settingsModal: q('settingsModal'),
    newChatModal: q('newChatModal'),
    closeNewChatBtn: q('closeNewChatBtn'),
    newChatFab: q('newChatFab'),
    searchInput: q('searchInput'),
    sidebarSubtitle: q('sidebarSubtitle'),
    chatList: q('chatList'),
    footerSyncDot: q('footerSyncDot'),
    footerSyncText: q('footerSyncText'),
    chatPane: q('chatPane'),
    backBtn: q('backBtn'),
    chatAvatar: q('chatAvatar'),
    chatTitle: q('chatTitle'),
    chatSubtitle: q('chatSubtitle'),
    emptyChatState: q('emptyChatState'),
    messagesRegion: q('messagesRegion'),
    messagesWrap: q('messagesWrap'),
    scrollBottomBtn: q('scrollBottomBtn'),
    composer: q('composer'),
    composerInput: q('composerInput'),
    sendBtn: q('sendBtn'),
    composerStatus: q('composerStatus'),
    hostInput: q('hostInput'),
    portInput: q('portInput'),
    pathInput: q('pathInput'),
    stunPathInput: q('stunPathInput'),
    activeAccountNameInfo: q('activeAccountNameInfo'),
    activeAccountGuidInfo: q('activeAccountGuidInfo'),
    accountsList: q('accountsList'),
    newAccountNicknameInput: q('newAccountNicknameInput'),
    createExtraAccountBtn: q('createExtraAccountBtn'),
    createExtraAccountStatus: q('createExtraAccountStatus'),
    connectionStatusText: q('connectionStatusText'),
    newChatNicknameInput: q('newChatNicknameInput'),
    newChatMessageInput: q('newChatMessageInput'),
    createDialogBtn: q('createDialogBtn'),
    createDialogAndSendBtn: q('createDialogAndSendBtn'),
    newChatStatus: q('newChatStatus'),
    accountModal: q('accountModal'),
    accountNicknameInput: q('accountNicknameInput'),
    createAccountBtn: q('createAccountBtn'),
    accountStatus: q('accountStatus'),
    chatContextMenu: q('chatContextMenu'),
    chatContextMenuTitle: q('chatContextMenuTitle'),
    deleteDialogBtn: q('deleteDialogBtn'),
    callBtn: q('callBtn'),
    chatConnectionBanner: q('chatConnectionBanner'),
    connectionTitle: q('connectionTitle'),
    connectionSubtitle: q('connectionSubtitle'),
    connectionPing: q('connectionPing'),
    callInlineBar: q('callInlineBar'),
    callInlineTitle: q('callInlineTitle'),
    callInlineSubtitle: q('callInlineSubtitle'),
    callMuteBtn: q('callMuteBtn'),
    callHangupBtn: q('callHangupBtn')
  });

  bindEvents();
}

export function isMessagesScrolledNearBottom() {
  const el = els.messagesWrap;
  if (!el || els.messagesRegion.style.display === 'none') return true;
  return (el.scrollHeight - el.clientHeight - el.scrollTop) <= SCROLL_BOTTOM_THRESHOLD;
}

export function hardScrollMessagesToBottom() {
  const el = els.messagesWrap;
  if (!el) return;

  el.scrollTop = el.scrollHeight;
  requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      updateScrollBottomButton();
    });
  });
}

export function updateScrollBottomButton() {
  const dialog = getSelectedDialog();
  if (!dialog || els.messagesRegion.style.display === 'none') {
    els.scrollBottomBtn.classList.remove('show');
    return;
  }

  if (isMessagesScrolledNearBottom()) {
    els.scrollBottomBtn.classList.remove('show');
  } else {
    els.scrollBottomBtn.classList.add('show');
  }
}

function openModal(modal) {
  if (modal) modal.classList.add('open');
}

function closeModal(modal) {
  if (modal) modal.classList.remove('open');
}

export function openAccountModal() {
  openModal(els.accountModal);
  requestAnimationFrame(() => els.accountNicknameInput?.focus());
}

function closeAccountModal() {
  if (!state.accounts.length) return;
  closeModal(els.accountModal);
}

function openSettings() {
  renderSettings();
  openModal(els.settingsModal);
}

function closeSettings() {
  closeModal(els.settingsModal);
}

function openNewChatModal() {
  els.newChatNicknameInput.value = '';
  els.newChatMessageInput.value = '';
  els.newChatStatus.className = 'helper';
  els.newChatStatus.textContent = 'Введи nickname, чтобы создать диалог.';
  openModal(els.newChatModal);
  requestAnimationFrame(() => els.newChatNicknameInput?.focus());
}

function closeNewChatModal() {
  closeModal(els.newChatModal);
}

function closeMobileChat() {
  els.chatPane.classList.remove('open');
}

function hideChatContextMenu() {
  els.chatContextMenu.classList.remove('open');
  state.chatContextPeerGuid = '';
  state.chatContextPeerNickname = '';
}

function openChatContextMenu(x, y, peerGuid, peerNickname) {
  state.chatContextPeerGuid = peerGuid;
  state.chatContextPeerNickname = peerNickname;
  els.chatContextMenuTitle.textContent = peerNickname || 'Диалог';
  els.chatContextMenu.classList.add('open');
  els.chatContextMenu.style.left = '0px';
  els.chatContextMenu.style.top = '0px';

  const rect = els.chatContextMenu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));

  els.chatContextMenu.style.left = `${left}px`;
  els.chatContextMenu.style.top = `${top}px`;
}

function renderSidebarHeader() {
  const account = getActiveAccount();
  const dialogsCount = getDialogsSummary().length;
  els.sidebarSubtitle.textContent = account ? `${account.nickname} · диалогов: ${dialogsCount}` : 'Без аккаунта';
}

function renderFooterSync() {
  const account = getActiveAccount();
  els.footerSyncDot.className = 'footer-sync-dot';

  if (!account) {
    els.footerSyncText.textContent = 'Нужен аккаунт';
    return;
  }

  const retryLeft = Math.max(0, Math.ceil((Number(account.retryBlockedUntil || 0) - Date.now()) / 1000));

  if (state.syncing) {
    els.footerSyncDot.classList.add('busy');
    els.footerSyncText.textContent = 'Синхронизация...';
    return;
  }

  if (retryLeft > 0) {
    els.footerSyncDot.classList.add('error');
    els.footerSyncText.textContent = `Ждать ${retryLeft} сек.`;
    return;
  }

  if (account.lastSyncOk === true) {
    els.footerSyncDot.classList.add('ok');
    els.footerSyncText.textContent = account.lastSyncAt
      ? `Обновлено ${new Date(account.lastSyncAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
      : 'Готово';
    return;
  }

  if (account.lastSyncOk === false) {
    els.footerSyncDot.classList.add('error');
    els.footerSyncText.textContent = account.lastError || 'Ошибка синхронизации';
    return;
  }

  els.footerSyncText.textContent = 'Нет синхронизации';
}

function renderChatList() {
  const dialogs = getDialogsSummary().filter((dialog) => {
    const q = state.search.trim().toLowerCase();
    if (!q) return true;
    const last = dialog.lastMessage;
    const presentation = last ? getMessagePresentation(last) : null;
    const preview = presentation ? presentation.preview : '';
    const hay = `${dialog.peerNickname} ${preview}`.toLowerCase();
    return hay.includes(q);
  });

  if (!dialogs.length) {
    els.chatList.innerHTML = `<div class="empty-side">${getActiveAccount() ? 'Здесь пока пусто. Нажми кнопку внизу справа, чтобы открыть новый чат.' : 'Сначала создай аккаунт.'}</div>`;
    return;
  }

  const selectedPeerGuid = getSelectedPeerGuid();

  els.chatList.innerHTML = dialogs.map((dialog, index) => {
    const last = dialog.lastMessage;
    const presentation = last ? getMessagePresentation(last) : null;
    const preview = presentation ? presentation.preview : 'Пока нет сообщений';
    const previewText = last && last.direction === 'out' && presentation && presentation.kind === 'text'
      ? `Ты: ${preview}`
      : preview;
    const activeClass = dialog.peerGuid === selectedPeerGuid ? ' active' : '';
    const divider = index < dialogs.length - 1 ? '<div class="divider"></div>' : '';

    return `
      <div class="chat-row${activeClass}" data-peer-guid="${escapeHtml(dialog.peerGuid)}" data-peer-nickname="${escapeHtml(dialog.peerNickname)}">
        <div class="avatar small">${escapeHtml(getInitial(dialog.peerNickname))}</div>
        <div class="chat-main">
          <div class="row-head">
            <div class="row-title">${escapeHtml(dialog.peerNickname)}</div>
            <div class="row-time">${escapeHtml(last ? formatTime(last.timestamp) : '')}</div>
          </div>
          <div class="row-foot">
            <div class="row-preview">${escapeHtml(previewText)}</div>
            <div class="badge ${dialog.unread ? '' : 'hidden'}">${escapeHtml(String(dialog.unread || ''))}</div>
          </div>
        </div>
      </div>
      ${divider}
    `;
  }).join('');
}

function renderConnectionBanner(dialog) {
  if (!dialog) {
    els.chatConnectionBanner.style.display = 'none';
    return;
  }

  const status = getPeerConnectionStatus(dialog.peerGuid);

  els.chatConnectionBanner.style.display = 'flex';
  els.connectionTitle.textContent = status.directReady ? 'Прямая связь установлена' : 'Прямое соединение';
  els.connectionSubtitle.textContent = status.statusText || 'Нет данных';
  els.connectionPing.textContent = status.pingMs != null ? `ping: ${status.pingMs} ms` : 'ping: —';

  els.callBtn.disabled = !status.callEnabled;
  els.callBtn.classList.toggle('disabled', !status.callEnabled);

  els.callBtn.style.background = status.callEnabled
    ? 'linear-gradient(135deg, #4fd08b, #2baa62)'
    : 'rgba(255,255,255,0.06)';
  els.callBtn.style.color = '#fff';
  els.callBtn.style.boxShadow = status.callEnabled
    ? '0 10px 24px rgba(79,208,139,0.22)'
    : 'none';
}

function renderCallInlineBar(dialog) {
  if (!dialog) {
    els.callInlineBar.style.display = 'none';
    return;
  }

  const call = getCallState(dialog.peerGuid);
  if (call.callState === 'idle') {
    els.callInlineBar.style.display = 'none';
    return;
  }

  els.callInlineBar.style.display = 'flex';

  if (call.callState === 'incoming') {
    els.callInlineTitle.textContent = 'Входящий звонок';
    els.callInlineSubtitle.textContent = `От ${dialog.peerNickname}`;
    els.callMuteBtn.textContent = '✅';
    els.callMuteBtn.title = 'Принять';
    els.callHangupBtn.textContent = '✖';
    els.callHangupBtn.title = 'Отклонить';
    return;
  }

  if (call.callState === 'calling') {
    els.callInlineTitle.textContent = 'Исходящий звонок';
    els.callInlineSubtitle.textContent = `Ожидание ответа от ${dialog.peerNickname}`;
    els.callMuteBtn.textContent = '🎤';
    els.callMuteBtn.title = 'Микрофон';
    els.callHangupBtn.textContent = '⛔';
    els.callHangupBtn.title = 'Отменить';
    return;
  }

  els.callInlineTitle.textContent = `Звонок · ${formatCallDuration(call.elapsedSec)}`;
  els.callInlineSubtitle.textContent = call.audioEnabled ? 'Микрофон включён' : 'Микрофон выключен';
  els.callMuteBtn.textContent = call.audioEnabled ? '🎤' : '🔇';
  els.callMuteBtn.title = 'Микрофон';
  els.callHangupBtn.textContent = '⛔';
  els.callHangupBtn.title = 'Завершить';
}

function renderMessageHtml(dialog, message) {
  const meta = getMessagePresentation(message);

  if (meta.kind === 'call') {
    return `
      <div class="bubble-row ${escapeHtml(message.direction || 'in')}">
        <div class="bubble ${escapeHtml(message.direction || 'in')}">
          <div class="bubble-main">
            <div style="display:flex;align-items:center;gap:10px;">
              <div style="width:32px;height:32px;border-radius:999px;background:rgba(79,208,139,.16);display:grid;place-items:center;flex:0 0 auto;">📞</div>
              <div style="min-width:0;">
                <div style="font-size:14px;font-weight:700;">${escapeHtml(meta.title)}</div>
                <div style="margin-top:3px;font-size:12px;color:rgba(255,255,255,.74);">${escapeHtml(meta.subtitle || 'Без соединения')}</div>
              </div>
            </div>
            <div class="bubble-meta">
              <span>${escapeHtml(formatTime(message.timestamp))}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="bubble-row ${escapeHtml(message.direction || 'in')}">
      <div class="bubble ${escapeHtml(message.direction || 'in')}">
        <div class="bubble-main">
          ${message.direction === 'in' ? `<div class="bubble-author">${escapeHtml(message.from_nickname || dialog.peerNickname)}</div>` : ''}
          <div class="bubble-text">${escapeHtml(message.message)}</div>
          <div class="bubble-meta">
            <span>${escapeHtml(formatTime(message.timestamp))}</span>
          </div>
        </div>
        <div class="bubble-copy-wrap">
          <button class="copy-btn" type="button" data-copy-text="${escapeHtml(message.message)}" title="Копировать">⧉</button>
        </div>
      </div>
    </div>
  `;
}

function renderChatPane(options = {}) {
  const { preserveScroll = false, forceScrollBottom = false } = options;
  const dialog = getSelectedDialog();
  const previousNearBottom = isMessagesScrolledNearBottom();
  let prevOffsetFromBottom = 0;

  if (preserveScroll && els.messagesWrap) {
    prevOffsetFromBottom = els.messagesWrap.scrollHeight - els.messagesWrap.scrollTop;
  }

  if (!dialog) {
    els.chatTitle.textContent = 'Выбери чат';
    els.chatSubtitle.textContent = 'Нет активного диалога';
    els.chatAvatar.textContent = '?';
    els.emptyChatState.style.display = 'grid';
    els.messagesRegion.style.display = 'none';
    els.composer.style.display = 'none';
    renderConnectionBanner(null);
    renderCallInlineBar(null);
    updateScrollBottomButton();
    return;
  }

  const status = getPeerConnectionStatus(dialog.peerGuid);

  els.chatTitle.textContent = dialog.peerNickname;
  els.chatSubtitle.textContent = status.directReady
    ? `Прямая связь, сообщений: ${dialog.messages.length}`
    : `Через сервер, сообщений: ${dialog.messages.length}`;
  els.chatAvatar.textContent = getInitial(dialog.peerNickname);
  els.emptyChatState.style.display = 'none';
  els.messagesRegion.style.display = 'flex';
  els.composer.style.display = 'block';

  renderConnectionBanner(dialog);
  renderCallInlineBar(dialog);

  const parts = [];
  let lastDay = '';

  dialog.messages.forEach((message) => {
    const day = formatDateChip(message.timestamp);
    if (day && day !== lastDay) {
      parts.push(`<div class="day-chip">${escapeHtml(day)}</div>`);
      lastDay = day;
    }

    parts.push(renderMessageHtml(dialog, message));
  });

  els.messagesWrap.innerHTML = parts.join('');

  requestAnimationFrame(() => {
    if (forceScrollBottom) {
      hardScrollMessagesToBottom();
      return;
    }

    if (preserveScroll) {
      const newScrollTop = Math.max(0, els.messagesWrap.scrollHeight - prevOffsetFromBottom);
      els.messagesWrap.scrollTop = newScrollTop;
      updateScrollBottomButton();
      return;
    }

    if (previousNearBottom) {
      hardScrollMessagesToBottom();
    } else {
      updateScrollBottomButton();
    }
  });
}

function renderAccountsList() {
  const active = getActiveAccount();

  if (!state.accounts.length) {
    els.accountsList.innerHTML = '<div class="helper">Аккаунтов пока нет.</div>';
    return;
  }

  els.accountsList.innerHTML = state.accounts.map((acc) => {
    const isActive = active && active.id === acc.id;
    return `
      <div class="account-item${isActive ? ' active' : ''}" data-account-id="${escapeHtml(acc.id)}">
        <div class="avatar">${escapeHtml(getInitial(acc.nickname))}</div>
        <div class="account-main">
          <div class="account-name">${escapeHtml(acc.nickname)}</div>
          <div class="account-guid-short">${escapeHtml(shortGuid(acc.guid))}</div>
          ${isActive ? '<div class="chip">Активный аккаунт</div>' : ''}
        </div>
        <div class="account-actions">
          ${!isActive ? `<button class="ghost-btn" type="button" data-switch-account="${escapeHtml(acc.id)}">Переключить</button>` : ''}
          <button class="danger-btn" type="button" data-delete-account="${escapeHtml(acc.id)}">Удалить</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderSettings() {
  const active = getActiveAccount();
  els.hostInput.value = state.connection.host;
  els.portInput.value = state.connection.port;
  els.pathInput.value = state.connection.path;
  els.stunPathInput.value = state.connection.stunPath;
  els.activeAccountNameInfo.textContent = active ? active.nickname : 'Аккаунт не выбран';
  els.activeAccountGuidInfo.textContent = active ? active.guid : '—';
  renderAccountsList();
}

export function renderAll(options = {}) {
  renderSidebarHeader();
  renderFooterSync();
  renderChatList();
  renderSettings();
  renderChatPane(options);
  saveState();
}

async function handleCreateInitialAccount() {
  try {
    await createInitialAccount(els.accountNicknameInput.value);
    els.accountStatus.className = 'helper status-ok';
    els.accountStatus.textContent = 'Аккаунт создан.';
    closeAccountModal();
    renderAll();
  } catch (error) {
    els.accountStatus.className = 'helper status-error';
    els.accountStatus.textContent = error.message || 'Не удалось создать аккаунт.';
  }
}

async function handleCreateExtraAccount() {
  try {
    const account = await createExtraAccount(els.newAccountNicknameInput.value);
    els.newAccountNicknameInput.value = '';
    els.createExtraAccountStatus.className = 'helper status-ok';
    els.createExtraAccountStatus.textContent = `Аккаунт ${account.nickname} сохранён.`;
    renderAll();
  } catch (error) {
    els.createExtraAccountStatus.className = 'helper status-error';
    els.createExtraAccountStatus.textContent = error.message || 'Ошибка создания аккаунта.';
  }
}

async function handleOpenChat(sendNow = false) {
  try {
    const { peerGuid, peerNickname } = await openDialogByNickname(els.newChatNicknameInput.value);
    await ensureDirectForPeer(peerGuid, peerNickname);

    if (sendNow) {
      const text = String(els.newChatMessageInput.value || '').trim();
      if (text) {
        await sendMessageToPeer(peerGuid, peerNickname, text, { preferDirect: true });
      }
    }

    closeNewChatModal();
    renderAll({ forceScrollBottom: true });

    if (window.innerWidth <= 820) {
      els.chatPane.classList.add('open');
    }
  } catch (error) {
    els.newChatStatus.className = 'helper status-error';
    els.newChatStatus.textContent = error.message || 'Не удалось открыть чат';
  }
}

async function handleSendFromComposer() {
  const dialog = getSelectedDialog();
  if (!dialog) {
    els.composerStatus.className = 'composer-status status-error';
    els.composerStatus.textContent = 'Сначала выбери чат.';
    return;
  }

  const text = String(els.composerInput.value || '').trim();
  if (!text) {
    els.composerStatus.className = 'composer-status status-error';
    els.composerStatus.textContent = 'Сообщение пустое.';
    return;
  }

  try {
    await sendMessageToPeer(dialog.peerGuid, dialog.peerNickname, text, { preferDirect: true });
    els.composerInput.value = '';
    els.composerStatus.className = 'composer-status status-ok';
    els.composerStatus.textContent = 'Отправлено.';
    renderAll({ forceScrollBottom: true });
  } catch (error) {
    els.composerStatus.className = 'composer-status status-error';
    els.composerStatus.textContent = error.message || 'Ошибка отправки';
  }
}

async function handleCallButton() {
  const dialog = getSelectedDialog();
  if (!dialog) return;

  try {
    await startCall(dialog.peerGuid, dialog.peerNickname);
    renderAll();
  } catch (error) {
    els.composerStatus.className = 'composer-status status-error';
    els.composerStatus.textContent = error.message || 'Ошибка звонка';
  }
}

async function handleCallMuteOrAccept() {
  const dialog = getSelectedDialog();
  if (!dialog) return;

  const call = getCallState(dialog.peerGuid);
  if (call.callState === 'incoming') {
    await acceptIncomingCall(dialog.peerGuid, dialog.peerNickname);
  } else if (call.callState === 'active') {
    await toggleMute(dialog.peerGuid);
  }

  renderAll();
}

async function handleCallHangupOrReject() {
  const dialog = getSelectedDialog();
  if (!dialog) return;

  const call = getCallState(dialog.peerGuid);
  if (call.callState === 'incoming') {
    await rejectIncomingCall(dialog.peerGuid);
  } else {
    await hangupCall(dialog.peerGuid);
  }

  renderAll();
}

function bindEvents() {
  els.settingsBtn?.addEventListener('click', openSettings);
  els.closeSettingsBtn?.addEventListener('click', closeSettings);
  els.newChatFab?.addEventListener('click', openNewChatModal);
  els.closeNewChatBtn?.addEventListener('click', closeNewChatModal);
  els.backBtn?.addEventListener('click', closeMobileChat);
  els.createAccountBtn?.addEventListener('click', handleCreateInitialAccount);
  els.createExtraAccountBtn?.addEventListener('click', handleCreateExtraAccount);
  els.createDialogBtn?.addEventListener('click', () => handleOpenChat(false));
  els.createDialogAndSendBtn?.addEventListener('click', () => handleOpenChat(true));
  els.sendBtn?.addEventListener('click', handleSendFromComposer);
  els.scrollBottomBtn?.addEventListener('click', hardScrollMessagesToBottom);
  els.callBtn?.addEventListener('click', handleCallButton);
  els.callMuteBtn?.addEventListener('click', handleCallMuteOrAccept);
  els.callHangupBtn?.addEventListener('click', handleCallHangupOrReject);

  els.searchInput?.addEventListener('input', (event) => {
    state.search = event.target.value || '';
    renderChatList();
  });

  els.accountNicknameInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleCreateInitialAccount();
    }
  });

  els.newAccountNicknameInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleCreateExtraAccount();
    }
  });

  els.composerInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSendFromComposer();
    }
  });

  els.messagesWrap?.addEventListener('scroll', updateScrollBottomButton);

  els.messagesWrap?.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-copy-text]');
    if (!btn) return;

    const old = btn.textContent;
    try {
      await copyText(String(btn.getAttribute('data-copy-text') || ''));
      btn.textContent = '✓';
    } catch (_) {
      btn.textContent = '!';
    }

    setTimeout(() => {
      btn.textContent = old;
    }, 800);
  });

  els.chatList?.addEventListener('click', async (event) => {
    const row = event.target.closest('[data-peer-guid]');
    if (!row) return;

    const peerGuid = String(row.getAttribute('data-peer-guid') || '');
    const peerNickname = String(row.getAttribute('data-peer-nickname') || '');

    if (!selectDialog(peerGuid)) return;
    await ensureDirectForPeer(peerGuid, peerNickname);
    renderAll({ preserveScroll: false });

    if (window.innerWidth <= 820) {
      els.chatPane.classList.add('open');
    }
  });

  els.chatList?.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('[data-peer-guid]');
    if (!row) return;

    event.preventDefault();
    openChatContextMenu(
      event.clientX,
      event.clientY,
      String(row.getAttribute('data-peer-guid') || ''),
      String(row.getAttribute('data-peer-nickname') || '')
    );
  });

  els.deleteDialogBtn?.addEventListener('click', () => {
    if (!state.chatContextPeerGuid) return;

    const ok = window.confirm(`Удалить диалог с ${state.chatContextPeerNickname || 'пользователем'}?`);
    if (!ok) return;

    deleteDialog(state.chatContextPeerGuid);
    hideChatContextMenu();
    renderAll();
  });

  els.accountsList?.addEventListener('click', async (event) => {
    const switchBtn = event.target.closest('[data-switch-account]');
    if (switchBtn) {
      switchAccount(String(switchBtn.getAttribute('data-switch-account') || ''));
      renderAll();
      return;
    }

    const deleteBtn = event.target.closest('[data-delete-account]');
    if (deleteBtn) {
      const accountId = String(deleteBtn.getAttribute('data-delete-account') || '');
      const ok = window.confirm('Удалить аккаунт и все его локальные данные?');
      if (!ok) return;

      deleteAccount(accountId);
      renderAll();

      if (!state.accounts.length) openAccountModal();
    }
  });

  [els.accountModal, els.settingsModal, els.newChatModal].forEach((modal) => {
    modal?.addEventListener('click', (event) => {
      if (event.target !== modal) return;
      if (modal === els.settingsModal) closeSettings();
      if (modal === els.newChatModal) closeNewChatModal();
      if (modal === els.accountModal) closeAccountModal();
    });
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('#chatContextMenu')) {
      hideChatContextMenu();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideChatContextMenu();
      closeSettings();
      closeNewChatModal();
      if (window.innerWidth <= 820) closeMobileChat();
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 820) {
      els.chatPane.classList.remove('open');
    }
    hideChatContextMenu();
    updateScrollBottomButton();
  });
}