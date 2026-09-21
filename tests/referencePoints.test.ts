import { test } from "node:test";
import assert from "node:assert/strict";
import { ReferencePointSync, emptyReferenceStore, importReferencePoints, mergeReferenceChanges, parseReferenceStore } from "../src/referencePoints.ts";
import type { ReferenceRemote, SavedReferencePointStore } from "../src/referencePoints.ts";

const point = (id: string) => ({ id, name: id, lat: -33, lon: 151 });
const store = (...ids: string[]): SavedReferencePointStore => ({
  version: 1, activeGroupId: "g", groups: [{ id: "g", name: "Location", points: ids.map(point) }],
});
const ids = (value: SavedReferencePointStore) => value.groups.flatMap(g => g.points.map(p => p.id)).sort();
const memoryStorage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};
const backend = () => {
  let row: { store: SavedReferencePointStore; revision: number } | null = null;
  let offline = false;
  const remote: ReferenceRemote = {
    async read() { if (offline) throw new Error("offline"); return structuredClone(row); },
    async write(value, revision) {
      if (offline) throw new Error("offline");
      if ((row?.revision ?? null) !== revision) return false;
      row = { store: structuredClone(value), revision: (revision ?? 0) + 1 };
      return true;
    },
  };
  return { remote, read: () => row, offline: (value: boolean) => { offline = value; } };
};

test("merges independent edits and propagates deletions without resurrecting stale points", () => {
  assert.deepEqual(ids(mergeReferenceChanges(store("a"), store("a", "b"), store("a", "c"))), ["a", "b", "c"]);
  assert.deepEqual(ids(mergeReferenceChanges(store("a", "b"), store("a", "b", "c"), store("b"))), ["b", "c"]);
  assert.deepEqual(ids(mergeReferenceChanges(store("a", "b"), store("b"), store("a", "b", "c"))), ["b", "c"]);
  assert.deepEqual(mergeReferenceChanges(store("a"), store("a"), emptyReferenceStore()).groups, []);
});

test("import preserves account points and is idempotent even before the initial cloud load", () => {
  const imported = importReferencePoints(store("a", "b"), store("b", "c"));
  assert.deepEqual(ids(imported), ["a", "b", "c"]);
  assert.deepEqual(importReferencePoints(store("a", "b"), imported), imported);
  assert.deepEqual(ids(mergeReferenceChanges(emptyReferenceStore(), store("a", "b"), store("b", "c"))), ["a", "b", "c"]);
});

test("parser rejects corrupt data instead of replacing it with an empty cloud document", () => {
  assert.throws(() => parseReferenceStore({ version: 2, groups: [] }));
  const invalid = store("a"); invalid.groups[0].points[0].lat = 999;
  assert.throws(() => parseReferenceStore(invalid));
});

test("two devices save concurrently without losing either device's points", async () => {
  const db = backend();
  const a = new ReferencePointSync(db.remote, memoryStorage(), "account");
  const b = new ReferencePointSync(db.remote, memoryStorage(), "account");
  a.start(); b.start(); await Promise.all([a.sync(), b.sync()]);
  a.update(store("a")); b.update(store("b"));
  await Promise.all([a.sync(), b.sync()]);
  await a.sync(); await b.sync();
  assert.deepEqual(ids(db.read()!.store), ["a", "b"]);
  assert.deepEqual(ids(a.getSnapshot().store), ["a", "b"]);
  assert.deepEqual(ids(b.getSnapshot().store), ["a", "b"]);
});

test("offline edits survive reload and merge with newer remote points on retry", async () => {
  const db = backend(); const storage = memoryStorage();
  await db.remote.write(store("a"), null);
  const first = new ReferencePointSync(db.remote, storage, "account");
  first.start(); await first.sync(); db.offline(true);
  first.update(store("a", "b")); await first.sync();
  assert.equal(first.getSnapshot().error, true); first.stop();
  db.offline(false); await db.remote.write(store("a", "c"), 1);
  const reloaded = new ReferencePointSync(db.remote, storage, "account");
  reloaded.start(); await reloaded.sync();
  assert.deepEqual(ids(db.read()!.store), ["a", "b", "c"]);
  assert.equal(reloaded.getSnapshot().error, false);
});

test("remote deletion reaches a cached device without being uploaded again", async () => {
  const db = backend(); await db.remote.write(store("a", "b"), null);
  const controller = new ReferencePointSync(db.remote, memoryStorage(), "account");
  controller.start(); await controller.sync();
  await db.remote.write(store("b"), 1); await controller.sync();
  assert.deepEqual(ids(controller.getSnapshot().store), ["b"]);
  assert.equal(db.read()!.revision, 2);
});

test("edits made during an upload are also synced", async () => {
  const db = backend();
  let release!: () => void;
  let started!: () => void;
  const writing = new Promise<void>(resolve => { started = resolve; });
  const pause = new Promise<void>(resolve => { release = resolve; });
  let firstWrite = true;
  const remote: ReferenceRemote = { ...db.remote, async write(value, revision) {
    if (firstWrite) { firstWrite = false; started(); await pause; }
    return db.remote.write(value, revision);
  } };
  const controller = new ReferencePointSync(remote, memoryStorage(), "account");
  controller.start(); await controller.sync(); controller.update(store("a"));
  await writing; controller.update(store("a", "b")); release(); await controller.sync();
  assert.deepEqual(ids(db.read()!.store), ["a", "b"]);
});

test("account cache isolation and cancelled reads prevent data leaking across account switches", async () => {
  const storage = memoryStorage(); const db = backend();
  const a = new ReferencePointSync(db.remote, storage, "account:a");
  a.start(); await a.sync(); db.offline(true); a.update(store("private")); await a.sync(); a.stop();
  const b = new ReferencePointSync(db.remote, storage, "account:b");
  assert.deepEqual(b.getSnapshot().store.groups, []);
  let release!: (row: { store: SavedReferencePointStore; revision: number }) => void;
  let writes = 0;
  const slow = new ReferencePointSync({
    read: () => new Promise(resolve => { release = resolve; }),
    write: async () => { writes++; return true; },
  }, memoryStorage(), "slow");
  slow.start(); slow.update(store("pending")); slow.stop();
  release({ store: store("other"), revision: 1 }); await slow.sync();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(writes, 0);
  assert.deepEqual(ids(slow.getSnapshot().store), ["pending"]);
});

test("failed import remains queued after reload and original browser data remains untouched", async () => {
  const storage = memoryStorage(); storage.setItem("legacy", JSON.stringify(store("a")));
  const db = backend(); db.offline(true);
  const controller = new ReferencePointSync(db.remote, storage, "account");
  controller.start(); controller.import(store("a")); await controller.sync(); controller.stop();
  const reloaded = new ReferencePointSync(db.remote, storage, "account");
  assert.equal(reloaded.getSnapshot().imported, true);
  db.offline(false); reloaded.start(); await reloaded.sync();
  assert.deepEqual(ids(db.read()!.store), ["a"]);
  assert.equal(storage.getItem("legacy"), JSON.stringify(store("a")));
});

