import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLeaguePreviewClient,
  createPreviewStore,
  PREVIEW_USER_ID,
} from "../src/leaguePreviewClient.ts";

test("preview roles show separate views without a real auth token or app access", async () => {
  const store = createPreviewStore();
  const visitor = createLeaguePreviewClient(store, "visitor");
  assert.equal((await visitor.auth.getSession()).data.session, null);
  const competitor = createLeaguePreviewClient(store, "competitor");
  const session = (await competitor.auth.getSession()).data.session;
  assert.equal(session?.user.id, PREVIEW_USER_ID);
  assert.equal(session?.access_token, undefined);
  assert.equal(
    (await competitor.rpc("current_user_has_app_access")).data,
    false,
  );
  assert.equal((await competitor.rpc("current_user_is_app_owner")).data, false);
  const organiser = createLeaguePreviewClient(store, "organiser");
  assert.equal((await organiser.rpc("current_user_is_app_owner")).data, true);
  assert.equal(
    (await organiser.rpc("current_user_has_app_access")).data,
    false,
  );
});

test("sample review, feedback, and uploads never use the network", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("Preview must not make network calls");
  }) as typeof fetch;
  try {
    const store = createPreviewStore();
    const organiser = createLeaguePreviewClient(store, "organiser");
    const competitor = createLeaguePreviewClient(store, "competitor");
    const pending = store.entries.find((row) => row.status === "pending")!;
    assert.ok(
      (
        await organiser.rpc("league_review_entry", {
          entry_id: pending.id,
          decision: "approved",
        })
      ).error,
    );
    assert.ok(
      (
        await competitor.functions.invoke("league-score", {
          body: { entry_id: pending.id },
        })
      ).error,
    );
    assert.equal(
      (
        await organiser.functions.invoke("league-score", {
          body: { entry_id: pending.id },
        })
      ).error,
      null,
    );
    assert.equal(
      (
        await organiser.rpc("league_review_entry", {
          entry_id: pending.id,
          decision: "approved",
          note: "Sample review",
        })
      ).error,
      null,
    );
    assert.equal(
      (
        await organiser.rpc("league_coaching_note", {
          entry_id: pending.id,
          note: "Sample coaching feedback",
        })
      ).error,
      null,
    );
    const own = await competitor.from("league_entries").select("*");
    assert.equal(own.data?.length, 1);
    assert.equal(own.data?.[0].coaching_note, "Sample coaching feedback");
    const blob = new Blob(["test file"]);
    assert.equal(
      (await competitor.storage.from("league-tracks").upload("local.csv", blob))
        .error,
      null,
    );
    assert.equal(
      await (
        await competitor.storage.from("league-tracks").download("local.csv")
      ).data?.text(),
      "test file",
    );
    assert.equal((await organiser.auth.signOut()).error, null);
    assert.equal((await organiser.auth.getSession()).data.session, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resetting the preview discards edits and local files", () => {
  const old = createPreviewStore();
  old.files.set("local.csv", new Blob(["test"]));
  old.entries[0].public_name = "Changed sample";
  const fresh = createPreviewStore();
  assert.equal(fresh.files.size, 0);
  assert.notEqual(fresh.entries[0].public_name, "Changed sample");
});
