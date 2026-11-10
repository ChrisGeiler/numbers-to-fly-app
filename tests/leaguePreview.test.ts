import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLeaguePreviewClient,
  createPreviewStore,
  PREVIEW_USER_ID,
} from "../src/leaguePreviewClient.ts";

const base = Date.parse("2026-11-01T00:00:00Z");
function trackCsv(northSpeed = 50) {
  const rows = ["time,lat,lon,hMSL,velN,velE,velD,hAcc,vAcc,sAcc,numSV"];
  for (let i = 0; i < 520; i++)
    rows.push(
      [
        new Date(base + i * 200).toISOString(),
        -33 + (((i * northSpeed * 0.2) / 6371000) * 180) / Math.PI,
        151,
        3300 - Math.max(0, i - 25) * 4,
        northSpeed,
        0,
        i < 25 ? 0 : 20,
        1,
        2,
        0.5,
        17,
      ].join(","),
    );
  return rows.join("\n");
}
function weatherFetcher(onCall: (url: string) => void = () => {}) {
  return (async (input: RequestInfo | URL) => {
    onCall(String(input));
    return new Response(
      JSON.stringify({
        hourly: {
          time: [base / 1000, base / 1000 + 3600],
          wind_speed_1000hPa: [10, 10],
          wind_direction_1000hPa: [180, 180],
          geopotential_height_1000hPa: [0, 0],
          wind_speed_500hPa: [10, 10],
          wind_direction_500hPa: [180, 180],
          geopotential_height_500hPa: [5000, 5000],
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}
async function upload(
  store: ReturnType<typeof createPreviewStore>,
  csv = trackCsv(),
) {
  const client = createLeaguePreviewClient(store, "competitor");
  if (!store.registrations.some((row) => row.user_id === PREVIEW_USER_ID)) {
    await client
      .from("league_registrations")
      .insert({
        user_id: PREVIEW_USER_ID,
        public_name: "Test pilot",
        region: "NSW",
      });
    await createLeaguePreviewClient(store, "organiser").rpc(
      "league_review_registration",
      { applicant_id: PREVIEW_USER_ID, decision: "approved" },
    );
  }
  const id = crypto.randomUUID(),
    roundId = String(store.rounds[0].id);
  const path = `${PREVIEW_USER_ID}/${roundId}/${id}.csv`;
  assert.equal(
    (await client.storage.from("league-tracks").upload(path, new Blob([csv])))
      .error,
    null,
  );
  assert.equal(
    (
      await client.from("league_entries").insert({
        id,
        user_id: PREVIEW_USER_ID,
        round_id: roundId,
        public_name: "Test pilot",
        region: "NSW",
        discipline: "speed",
        location_name: "Moruya",
        ground_elevation_m: 100,
        file_path: path,
      })
    ).error,
    null,
  );
  return { id, path, entry: store.entries.find((row) => row.id === id)! };
}

test("local test starts empty and does not create real auth or app access", async () => {
  const store = createPreviewStore();
  assert.equal(store.entries.length, 0);
  const visitor = createLeaguePreviewClient(store, "visitor");
  assert.equal((await visitor.auth.getSession()).data.session, null);
  const competitor = createLeaguePreviewClient(store, "competitor");
  assert.equal(
    (await competitor.auth.getSession()).data.session?.user.id,
    PREVIEW_USER_ID,
  );
  assert.equal(
    (await competitor.auth.getSession()).data.session?.access_token,
    undefined,
  );
  assert.equal(
    (await competitor.rpc("current_user_has_app_access")).data,
    false,
  );
  assert.equal(
    (
      await createLeaguePreviewClient(store, "organiser").rpc(
        "current_user_is_app_owner",
      )
    ).data,
    true,
  );
});

test("review scores the actual uploaded file with archived winds and retains provenance", async () => {
  const store = createPreviewStore();
  const uploaded = await upload(store);
  const calls: string[] = [];
  const organiser = createLeaguePreviewClient(
    store,
    "organiser",
    weatherFetcher((url) => calls.push(url)),
  );
  assert.ok(
    (
      await organiser.rpc("league_review_entry", {
        entry_id: uploaded.id,
        decision: "approved",
      })
    ).error,
  );
  assert.equal(
    (
      await organiser.functions.invoke("league-score", {
        body: { entry_id: uploaded.id },
      })
    ).error,
    null,
  );
  assert.equal(uploaded.entry.time_s, 50);
  assert.ok(Math.abs(Number(uploaded.entry.raw_distance_m) - 2500) < 0.001);
  assert.ok(
    Math.abs(Number(uploaded.entry.corrected_distance_m) - 2000) < 0.001,
  );
  assert.ok(Math.abs(Number(uploaded.entry.corrected_speed_kmh) - 144) < 0.001);
  assert.equal(uploaded.entry.scoring_version, "pilot-v1");
  assert.equal(String(uploaded.entry.file_hash).length, 64);
  assert.equal(
    (uploaded.entry.wind_snapshot as { model: string }).model,
    "gfs_global",
  );
  assert.ok(calls[0].includes("models=gfs_global"));
  assert.equal(uploaded.entry.status, "pending");
  await organiser.functions.invoke("league-score", {
    body: { entry_id: uploaded.id },
  });
  assert.equal(
    calls.length,
    1,
    "re-review must use the retained wind snapshot",
  );
  assert.equal(
    (
      await organiser.rpc("league_review_entry", {
        entry_id: uploaded.id,
        decision: "approved",
        note: "Checked",
      })
    ).error,
    null,
  );
  const results = await organiser.rpc("league_leaderboard", {
    selected_round: store.rounds[0].id,
  });
  assert.equal(results.data.length, 1);
  assert.equal(
    results.data[0].corrected_speed_kmh,
    uploaded.entry.corrected_speed_kmh,
  );
});

test("different original tracks produce different corrected scores", async () => {
  const store = createPreviewStore();
  const first = await upload(store, trackCsv(50)),
    second = await upload(store, trackCsv(80));
  const organiser = createLeaguePreviewClient(
    store,
    "organiser",
    weatherFetcher(),
  );
  await organiser.functions.invoke("league-score", {
    body: { entry_id: first.id },
  });
  await organiser.functions.invoke("league-score", {
    body: { entry_id: second.id },
  });
  assert.ok(
    Number(second.entry.corrected_speed_kmh) >
      Number(first.entry.corrected_speed_kmh),
  );
  assert.notEqual(first.entry.file_hash, second.entry.file_hash);
});

test("missing original or unavailable winds leave results pending and unapprovable", async () => {
  const store = createPreviewStore();
  const item = await upload(store);
  let calls = 0;
  const organiser = createLeaguePreviewClient(store, "organiser", (async () => {
    calls++;
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch);
  const response = await organiser.functions.invoke("league-score", {
    body: { entry_id: item.id },
  });
  assert.ok(response.error);
  assert.equal(item.entry.status, "pending");
  assert.equal(item.entry.corrected_speed_kmh, undefined);
  assert.ok(
    (
      await organiser.rpc("league_review_entry", {
        entry_id: item.id,
        decision: "approved",
      })
    ).error,
  );
  store.files.delete(item.path);
  assert.ok(
    (
      await organiser.functions.invoke("league-score", {
        body: { entry_id: item.id },
      })
    ).error,
  );
  assert.equal(calls, 1);
});

test("competitors cannot score or approve; feedback and original download use the actual local entry", async () => {
  const store = createPreviewStore();
  const item = await upload(store);
  const competitor = createLeaguePreviewClient(
    store,
    "competitor",
    weatherFetcher(),
  );
  const organiser = createLeaguePreviewClient(
    store,
    "organiser",
    weatherFetcher(),
  );
  assert.ok(
    (
      await competitor.functions.invoke("league-score", {
        body: { entry_id: item.id },
      })
    ).error,
  );
  assert.ok(
    (
      await competitor.rpc("league_review_entry", {
        entry_id: item.id,
        decision: "approved",
      })
    ).error,
  );
  await organiser.rpc("league_coaching_note", {
    entry_id: item.id,
    note: "Actual test feedback",
  });
  assert.equal(
    (await competitor.from("league_entries").select("*")).data?.[0]
      .coaching_note,
    "Actual test feedback",
  );
  assert.equal(
    await (
      await organiser.storage.from("league-tracks").download(item.path)
    ).data?.text(),
    trackCsv(),
  );
});

test("a new test store discards prior entries and files", async () => {
  const old = createPreviewStore();
  await upload(old);
  const fresh = createPreviewStore();
  assert.equal(fresh.entries.length, 0);
  assert.equal(fresh.files.size, 0);
  assert.notEqual(fresh.instanceId, old.instanceId);
  assert.equal(fresh.registrations.length, 0);
});

test("registration must be approved before uploads or round entries, including direct adapter calls", async () => {
  const store = createPreviewStore();
  const competitor = createLeaguePreviewClient(store, "competitor");
  const organiser = createLeaguePreviewClient(store, "organiser");
  const path = `${PREVIEW_USER_ID}/${store.rounds[0].id}/${crypto.randomUUID()}.csv`;
  const file = new Blob([trackCsv()]);
  assert.ok(
    (await competitor.storage.from("league-tracks").upload(path, file)).error,
  );
  assert.ok(
    (
      await competitor
        .from("league_registrations")
        .insert({
          user_id: PREVIEW_USER_ID,
          public_name: "Test pilot",
          region: "NSW",
          status: "approved",
        })
    ).error,
  );
  assert.equal(
    (
      await competitor
        .from("league_registrations")
        .insert({
          user_id: PREVIEW_USER_ID,
          public_name: "Test pilot",
          region: "NSW",
        })
    ).error,
    null,
  );
  assert.equal(store.registrations[0].status, "pending");
  assert.ok(
    (await competitor.storage.from("league-tracks").upload(path, file)).error,
  );
  assert.ok(
    (
      await competitor.rpc("league_review_registration", {
        applicant_id: PREVIEW_USER_ID,
        decision: "approved",
      })
    ).error,
  );
  assert.equal(
    (
      await organiser.rpc("league_review_registration", {
        applicant_id: PREVIEW_USER_ID,
        decision: "approved",
        note: "Welcome",
      })
    ).error,
    null,
  );
  assert.equal(
    (await competitor.storage.from("league-tracks").upload(path, file)).error,
    null,
  );
  await organiser.rpc("league_review_registration", {
    applicant_id: PREVIEW_USER_ID,
    decision: "rejected",
    note: "Entry access paused",
  });
  assert.ok(
    (
      await competitor
        .from("league_entries")
        .insert({
          id: crypto.randomUUID(),
          user_id: PREVIEW_USER_ID,
          round_id: store.rounds[0].id,
          file_path: path,
        })
    ).error,
  );
  assert.ok(
    (
      await competitor.storage
        .from("league-tracks")
        .upload(path.replace(".csv", "-second.csv"), file)
    ).error,
  );
  assert.equal(
    (await competitor.from("league_registrations").select("*")).data?.[0]
      .review_note,
    "Entry access paused",
  );
});
