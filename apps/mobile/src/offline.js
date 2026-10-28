// Read-only operational cache. Do not queue OTPs, financial postings or cash confirmations.
// Each segment is stored encrypted by OS SecureStore; never use unencrypted AsyncStorage for parcel data.
export const KEY = 'elesend.active-cache-v1';
export const MAX_SEGMENTS = 16, SEGMENT_CHARS = 1200, MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Hermes evaluates Metro modules synchronously: load SecureStore inside async operations,
// never with module-level await. Tests can continue injecting their own storage boundary.
let storePromise;
function getNativeStore() {
  storePromise ||= import('expo-secure-store').catch(() => {
    const mem = new Map();
    return {
      getItemAsync: async k => mem.get(k) ?? null,
      setItemAsync: async (k, v) => { mem.set(k, String(v)); },
      deleteItemAsync: async k => { mem.delete(k); }
    };
  });
  return storePromise;
}
const nativeStore = {
  getItemAsync: async (...args) => (await getNativeStore()).getItemAsync(...args),
  setItemAsync: async (...args) => (await getNativeStore()).setItemAsync(...args),
  deleteItemAsync: async (...args) => (await getNativeStore()).deleteItemAsync(...args)
};

export function createOfflineCache(store = nativeStore) {
  const s = store || nativeStore;
  return {
    async clearCachedJobs() {
      for (let i = 0; i < MAX_SEGMENTS; i++) await s.deleteItemAsync(`${KEY}.${i}`);
      await s.deleteItemAsync(`${KEY}.meta`);
    },
    async cacheJobs(actorId, { shipments = [], stops = [] } = {}) {
      const slim = {
        shipments: shipments.slice(0, 8).map(sm => ({
          id: sm.id,
          state: sm.state,
          amount_minor: sm.amount_minor,
          commission_minor: sm.commission_minor,
          payment_method: sm.payment_method,
          cash_payer: sm.cash_payer,
          details: sm.request && { pickup: sm.request.pickup?.address, destination: sm.request.destination?.address }
        })),
        stops: stops.slice(0, 16).map(st => ({
          shipmentId: st.shipmentId,
          kind: st.kind,
          position: st.position || st.location || null
        }))
      };
      const str = JSON.stringify(slim);
      if (str.length > MAX_SEGMENTS * SEGMENT_CHARS) return false;
      const count = Math.ceil(str.length / SEGMENT_CHARS);
      // Invalidate old metadata BEFORE writing and commit metadata LAST to prevent torn reads.
      await s.deleteItemAsync(`${KEY}.meta`);
      for (let i = 0; i < count; i++) {
        await s.setItemAsync(`${KEY}.${i}`, str.slice(i * SEGMENT_CHARS, (i + 1) * SEGMENT_CHARS));
      }
      await s.setItemAsync(`${KEY}.meta`, JSON.stringify({ actorId, savedAt: Date.now(), count }));
      return true;
    },
    async readCachedJobs(actorId, now = Date.now()) {
      const raw = await s.getItemAsync(`${KEY}.meta`);
      if (!raw) return null;
      const meta = JSON.parse(raw);
      if (meta.actorId !== actorId || now - meta.savedAt > MAX_AGE_MS || meta.count < 1 || meta.count > MAX_SEGMENTS) return null;
      let text = '';
      for (let i = 0; i < meta.count; i++) {
        const part = await s.getItemAsync(`${KEY}.${i}`);
        if (!part) return null;
        text += part;
      }
      return { ...JSON.parse(text), cachedAt: new Date(meta.savedAt).toISOString(), readOnly: true };
    }
  };
}

const defaultCache = createOfflineCache(nativeStore);

export async function clearCachedJobs(store) {
  return store ? createOfflineCache(store).clearCachedJobs() : defaultCache.clearCachedJobs();
}

export async function cacheJobs(actorId, data, store) {
  return store ? createOfflineCache(store).cacheJobs(actorId, data) : defaultCache.cacheJobs(actorId, data);
}

export async function readCachedJobs(actorId, store, now) {
  return store ? createOfflineCache(store).readCachedJobs(actorId, now) : defaultCache.readCachedJobs(actorId);
}
