import type { PreviewStore } from "./leaguePreviewClient";

const databaseName = "wingsuit-league-local-test-v1";
let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  if (!database)
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        database = undefined;
        reject(
          new Error(
            "Local test storage is unavailable. Enable browser storage to retain test tracks.",
          ),
        );
      };
    });
  return database;
}

type Snapshot = {
  rounds: PreviewStore["rounds"];
  entries: PreviewStore["entries"];
  files: [string, Blob][];
};
export async function readLeagueTestStore(): Promise<Snapshot | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("state", "readonly")
      .objectStore("state")
      .get("current");
    request.onsuccess = () => {
      const value = request.result;
      resolve(
        value &&
          Array.isArray(value.rounds) &&
          Array.isArray(value.entries) &&
          Array.isArray(value.files)
          ? value
          : null,
      );
    };
    request.onerror = () =>
      reject(new Error("Could not restore local test tracks."));
  });
}

let writes: Promise<void> = Promise.resolve();
export function writeLeagueTestStore(store: PreviewStore): Promise<void> {
  const snapshot: Snapshot = structuredClone({
    rounds: store.rounds,
    entries: store.entries,
    files: [...store.files],
  });
  const save = async () => {
    const db = await openDatabase();
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("state", "readwrite");
      transaction.objectStore("state").put(snapshot, "current");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(
          new Error(
            "Could not save the local test. Check available browser storage.",
          ),
        );
      transaction.onabort = () =>
        reject(new Error("Local test storage was interrupted."));
    });
  };
  writes = writes.catch(() => {}).then(save);
  return writes;
}
