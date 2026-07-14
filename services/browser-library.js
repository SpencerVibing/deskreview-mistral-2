const LIBRARY_DB_NAME = 'deskreview-mistral-2';
const LIBRARY_DB_VERSION = 1;
const LIBRARY_STORE = 'reviews';

function openLibraryDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LIBRARY_DB_NAME, LIBRARY_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LIBRARY_STORE)) {
        const store = db.createObjectStore(LIBRARY_STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open browser storage.'));
  });
}

async function libraryRequest(mode = 'readonly', action) {
  const db = await openLibraryDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(LIBRARY_STORE, mode);
    const store = transaction.objectStore(LIBRARY_STORE);
    const request = action(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Browser storage request failed.'));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error('Browser storage transaction failed.'));
    };
  });
}

export async function listStoredReviews() {
  const reviews = await libraryRequest('readonly', (store) => store.getAll());
  return reviews.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export async function getStoredReview(id = '') {
  return libraryRequest('readonly', (store) => store.get(id));
}

export async function putStoredReview(review = {}) {
  return libraryRequest('readwrite', (store) => store.put(review));
}

export async function deleteStoredReview(id = '') {
  return libraryRequest('readwrite', (store) => store.delete(id));
}
