export type SavedReferencePoint = {
  id: string;
  name: string;
  lat: number;
  lon: number;
};

export type SavedReferencePointGroup = {
  id: string;
  name: string;
  points: SavedReferencePoint[];
};

export type SavedReferencePointStore = {
  version: 1;
  activeGroupId: string | null;
  groups: SavedReferencePointGroup[];
};

export const LEGACY_REFERENCE_KEY = "numbers-to-fly:reference-point-groups";
export const emptyReferenceStore = (): SavedReferencePointStore => ({
  version: 1, activeGroupId: null, groups: [],
});

export function parseReferenceStore(value: unknown): SavedReferencePointStore {
  if (!value || typeof value !== "object") throw new Error("Invalid reference points");
  const store = value as SavedReferencePointStore;
  if (store.version !== 1 || !Array.isArray(store.groups)) {
    throw new Error("Unsupported reference point format");
  }
  const groupIds = new Set<string>();
  for (const group of store.groups) {
    if (!group || typeof group.id !== "string" || !group.id ||
        groupIds.has(group.id) || typeof group.name !== "string" ||
        !group.name.trim() || !Array.isArray(group.points)) {
      throw new Error("Invalid reference location");
    }
    groupIds.add(group.id);
    const pointIds = new Set<string>();
    for (const point of group.points) {
      if (!point || typeof point.id !== "string" || !point.id ||
          pointIds.has(point.id) || typeof point.name !== "string" ||
          !point.name.trim() || !Number.isFinite(point.lat) ||
          Math.abs(point.lat) > 90 || !Number.isFinite(point.lon) ||
          Math.abs(point.lon) > 180) throw new Error("Invalid reference point");
      pointIds.add(point.id);
    }
  }
  return {
    version: 1,
    activeGroupId: store.activeGroupId === null || groupIds.has(store.activeGroupId)
      ? store.activeGroupId : store.groups[0]?.id ?? null,
    groups: store.groups,
  };
}

export const sameReferences = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Apply only local changes to the latest remote snapshot. An unchanged stale
// device must never resurrect deleted points or overwrite another device's work.
function mergeItems<T extends { id: string }>(base: T[], local: T[], remote: T[],
  merge?: (base: T | undefined, local: T, remote: T) => T): T[] {
  const result = new Map(remote.map(item => [item.id, item]));
  for (const item of base) {
    if (!local.some(candidate => candidate.id === item.id)) result.delete(item.id);
  }
  for (const item of local) {
    const before = base.find(candidate => candidate.id === item.id);
    if (sameReferences(before, item)) continue;
    const latest = result.get(item.id);
    // A remote deletion wins over an edit of an existing item.
    if (before && !latest) continue;
    result.set(item.id, latest && merge ? merge(before, item, latest) : item);
  }
  return [...result.values()];
}

export function mergeReferenceChanges(base: SavedReferencePointStore,
  local: SavedReferencePointStore, remote: SavedReferencePointStore): SavedReferencePointStore {
  const groups = mergeItems(base.groups, local.groups, remote.groups, (before, edited, latest) => ({
    ...latest,
    name: !before || before.name === edited.name ? latest.name : edited.name,
    points: before ? mergeItems(before.points, edited.points, latest.points)
      : [...latest.points, ...edited.points.filter(point => !latest.points.some(p => p.id === point.id))],
  }));
  const selected = local.activeGroupId;
  return { version: 1, groups,
    activeGroupId: selected === null || groups.some(group => group.id === selected)
      ? selected : groups[0]?.id ?? null };
}

// Import is additive and idempotent; existing account points take precedence.
export function importReferencePoints(local: SavedReferencePointStore,
  account: SavedReferencePointStore): SavedReferencePointStore {
  const groups = new Map(account.groups.map(group => [group.id, group]));
  for (const group of local.groups) {
    const existing = groups.get(group.id);
    groups.set(group.id, existing ? { ...existing, points: [
      ...existing.points, ...group.points.filter(point => !existing.points.some(p => p.id === point.id)),
    ] } : group);
  }
  return { version: 1, groups: [...groups.values()],
    activeGroupId: account.activeGroupId ?? local.activeGroupId };
}

export type ReferenceRemote = {
  read: () => Promise<{ store: SavedReferencePointStore; revision: number } | null>;
  write: (store: SavedReferencePointStore, revision: number | null) => Promise<boolean>;
};

type Cache = { base: SavedReferencePointStore; store: SavedReferencePointStore; imported?: boolean };
type Snapshot = { store: SavedReferencePointStore; status: string; imported: boolean; error: boolean };

// No React or network dependency here, so race/retry behaviour can be tested.
export class ReferencePointSync {
  private base = emptyReferenceStore();
  private snapshot: Snapshot = { store: emptyReferenceStore(), status: "Loading reference points…", imported: false, error: false };
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private active = false;
  private generation = 0;
  private storageError = false;
  private cacheReadError = false;
  private remote: ReferenceRemote | null;
  private storage: Pick<Storage, "getItem" | "setItem">;
  private key: string;

  constructor(remote: ReferenceRemote | null, storage: Pick<Storage, "getItem" | "setItem">, key: string) {
    this.remote = remote;
    this.storage = storage;
    this.key = key;
    try {
      const raw = storage.getItem(key);
      if (raw) {
        const data = JSON.parse(raw);
        const cache: Cache = remote ? data : { base: emptyReferenceStore(), store: data };
        this.base = parseReferenceStore(cache.base);
        this.snapshot = { ...this.snapshot, store: parseReferenceStore(cache.store), imported: !!cache.imported };
      }
    } catch {
      this.cacheReadError = true;
      this.snapshot = { ...this.snapshot, error: true, status: "Browser reference points could not be read. Existing browser data has been preserved." };
    }
    if (!remote && !this.cacheReadError) this.snapshot.status = "Saved on this browser only. Sign in to sync across devices.";
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(values: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...values };
    this.listeners.forEach(listener => listener());
  }
  private persist() {
    if (this.cacheReadError) return;
    try {
      this.storage.setItem(this.key, JSON.stringify(this.remote
        ? { base: this.base, store: this.snapshot.store, imported: this.snapshot.imported }
        : this.snapshot.store));
      this.storageError = false;
    } catch { this.storageError = true; }
  }
  update = (value: SavedReferencePointStore | ((store: SavedReferencePointStore) => SavedReferencePointStore)) => {
    if (!this.active || this.cacheReadError) return;
    const store = typeof value === "function" ? value(this.snapshot.store) : value;
    this.publish({ store, status: this.remote ? "Syncing reference points…" : "Saved on this browser only. Sign in to sync across devices.", error: false });
    this.persist();
    if (this.storageError) this.publish({ error: true, status: "Browser storage is unavailable. Keep this page open until your points are synced." });
    void this.sync();
  };
  import = (store: SavedReferencePointStore) => {
    if (!this.active || this.cacheReadError || this.snapshot.imported) return;
    this.publish({ imported: true });
    this.update(current => importReferencePoints(store, current));
  };
  start() { this.active = true; void this.sync(); }
  stop() { this.active = false; this.generation++; }

  sync = (): Promise<void> => {
    if (!this.remote || !this.active || this.cacheReadError) return Promise.resolve();
    if (this.running) return this.running;
    const generation = this.generation;
    const current = () => this.active && generation === this.generation;
    this.running = (async () => {
      try {
        for (let attempt = 0; attempt < 8 && current(); attempt++) {
          const row = await this.remote!.read();
          if (!current()) return;
          const remoteStore = row?.store ?? emptyReferenceStore();
          const merged = mergeReferenceChanges(this.base, this.snapshot.store, remoteStore);
          // activeGroupId is device-specific; selecting a group doesn't write cloud data.
          if (sameReferences(merged.groups, remoteStore.groups)) {
            this.base = merged;
            this.publish({ store: merged, status: "Reference points synced to your account.", error: false });
            this.persist();
            return;
          }
          this.publish({ status: "Syncing reference points…", error: false });
          const sent = this.snapshot.store;
          const written = await this.remote!.write(merged, row?.revision ?? null);
          if (!current()) return;
          if (!written) continue; // Another device wrote first: reread and merge.
          // Retain edits made while the request was in flight.
          const store = mergeReferenceChanges(sent, this.snapshot.store, merged);
          this.base = merged;
          this.publish({ store });
          this.persist();
          if (sameReferences(store.groups, merged.groups)) {
            this.publish({ status: "Reference points synced to your account.", error: false });
            return;
          }
        }
        if (current()) throw new Error("Concurrent updates");
      } catch {
        if (current()) this.publish({ error: true, status: this.storageError
          ? "Reference points are not synced and could not be saved in this browser. Keep this page open and retry."
          : "Reference points could not sync. Your browser copy is kept; reconnect or retry." });
      }
    })().finally(() => {
      this.running = null;
      // React Strict Mode can stop/start a controller while its read is in flight.
      if (this.active && generation !== this.generation) void this.sync();
    });
    return this.running;
  };
}
