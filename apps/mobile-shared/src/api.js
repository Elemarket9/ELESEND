import * as SecureStore from 'expo-secure-store';
import {API_BASE_URL} from './config.js';

export const BASE = API_BASE_URL;

export const loadToken = () => SecureStore.getItemAsync('elesend.session');
export const saveToken = t => SecureStore.setItemAsync('elesend.session', t);
export const clearToken = () => SecureStore.deleteItemAsync('elesend.session');

export async function call(method, path, body = null, {token = null, idempotencyKey = null} = {}) {
  if (!BASE) throw Error('Configure EXPO_PUBLIC_ELESEND_API_BASE_URL to an HTTPS backend');
  const bearer = token ?? await loadToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? {Authorization: `Bearer ${bearer}`} : {}),
        ...(idempotencyKey ? {'Idempotency-Key': idempotencyKey} : {})
      },
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || `Request failed: ${response.status}`);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export const ghc = minor => `GH₵${(Number(minor ?? 0) / 100).toFixed(2)}`;

export const parseGhs = v => {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec((v || '').trim());
  if (!m) throw Error('Enter Ghana cedis as 30 or 30.00');
  return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
};
