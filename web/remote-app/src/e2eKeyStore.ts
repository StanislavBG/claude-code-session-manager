// Persists the browser's E2E ECDH keypair across page reloads so a returning
// browser presents the SAME public key to the desktop instead of a fresh one
// on every reload (which would otherwise force SAS re-confirmation every time).
// IndexedDB (unlike localStorage) can store a non-extractable CryptoKey directly
// via structured clone — the private key never has to be exported.

const DB_NAME = 'sm-e2e-keys';
const DB_VERSION = 1;
const STORE_NAME = 'keypairs';

interface StoredKeyPair {
  deviceId: string;
  privateKey: CryptoKey;
  publicKeyB64: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'deviceId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
  });
}

export async function loadKeyPair(
  deviceId: string,
): Promise<{ privateKey: CryptoKey; publicKeyB64: string } | null> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(deviceId);
      req.onsuccess = () => {
        const record = req.result as StoredKeyPair | undefined;
        if (!record) {
          resolve(null);
          return;
        }
        resolve({ privateKey: record.privateKey, publicKeyB64: record.publicKeyB64 });
      };
      req.onerror = () => reject(req.error ?? new Error('IDB get failed'));
    });
  } finally {
    db.close();
  }
}

export async function saveKeyPair(
  deviceId: string,
  privateKey: CryptoKey,
  publicKeyB64: string,
): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const record: StoredKeyPair = { deviceId, privateKey, publicKeyB64 };
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IDB put failed'));
    });
  } finally {
    db.close();
  }
}
