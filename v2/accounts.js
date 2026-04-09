import { state, getActiveAccount } from './state.js';
import { createAccountObject, saveState } from './storage.js';
import { USER_NAMESPACE, sanitizeNickname, uuidV5 } from './utils.js';

export async function createAccountByNickname(nickname, switchToNew = true) {
  const cleanNickname = sanitizeNickname(nickname);
  if (!cleanNickname) {
    throw new Error('Введите nickname.');
  }

  const guid = (await uuidV5(USER_NAMESPACE, cleanNickname)).toLowerCase();
  const existing = state.accounts.find((acc) => acc.guid === guid);

  if (existing) {
    if (switchToNew) {
      state.activeAccountId = existing.id;
      saveState();
    }
    return existing;
  }

  const account = createAccountObject(cleanNickname, guid);
  state.accounts.push(account);

  if (switchToNew || !state.activeAccountId) {
    state.activeAccountId = account.id;
  }

  saveState();
  return account;
}

export async function createInitialAccount(nickname) {
  return createAccountByNickname(nickname, true);
}

export async function createExtraAccount(nickname) {
  return createAccountByNickname(nickname, false);
}

export function switchAccount(accountId) {
  const exists = state.accounts.find((acc) => acc.id === accountId);
  if (!exists) return false;

  state.activeAccountId = accountId;
  saveState();
  return true;
}

export function deleteAccount(accountId) {
  const index = state.accounts.findIndex((acc) => acc.id === accountId);
  if (index === -1) return false;

  state.accounts.splice(index, 1);

  if (state.activeAccountId === accountId) {
    state.activeAccountId = state.accounts[0] ? state.accounts[0].id : '';
  }

  saveState();
  return true;
}

export function getActiveAccountInfo() {
  const account = getActiveAccount();
  if (!account) return null;

  return {
    id: account.id,
    nickname: account.nickname,
    guid: account.guid
  };
}
