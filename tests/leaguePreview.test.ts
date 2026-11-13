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

function entryChanges(entry: Record<string, unknown>, overrides: Record<string,unknown> = {}) {
  return { public_name:entry.public_name,region:entry.region,discipline:entry.discipline,
    location_name:entry.location_name,ground_elevation_m:entry.ground_elevation_m,
    coaching_requested:Boolean(entry.coaching_requested),file_path:entry.file_path,...overrides };
}

test("pending category changes require valid categories and organiser re-review", async () => {
  const store = createPreviewStore();
  const {id,entry} = await upload(store);
  const client = createLeaguePreviewClient(store,"competitor");
  assert.ok((await client.rpc("league_edit_entry",{entry_id:id,expected_revision:0,changes:entryChanges(entry,{category:"elite"})})).error);
  assert.equal(entry.category,"open");
  Object.assign(entry,{scoring_version:"pilot-v1",corrected_speed_kmh:200,replay_data:{version:1,points:[]}});
  assert.equal((await client.rpc("league_edit_entry",{entry_id:id,expected_revision:0,changes:entryChanges(entry,{category:"beginner"})})).error,null);
  assert.equal(entry.category,"beginner");
  assert.equal(entry.scoring_version,null);
  assert.equal(entry.replay_data,null);
  assert.equal(entry.status,"pending");
  entry.status="approved";
  assert.ok((await client.rpc("league_edit_entry",{entry_id:id,expected_revision:1,changes:entryChanges(entry,{category:"open"})})).error);
});

test("pending entry edits are owner-only, clear scores and require a fresh revision for approval", async () => {
  const store=createPreviewStore(), item=await upload(store);
  const competitor=createLeaguePreviewClient(store,"competitor");
  const organiser=createLeaguePreviewClient(store,"organiser",weatherFetcher());
  await organiser.functions.invoke("league-score",{body:{entry_id:item.id}});
  assert.ok(item.entry.scoring_version);assert.ok(item.entry.replay_data);
  const forbidden=await competitor.rpc("league_edit_entry",{entry_id:item.id,expected_revision:0,changes:entryChanges(item.entry,{corrected_speed_kmh:999})});
  assert.ok(forbidden.error);assert.equal(item.entry.revision,0);
  const edited=await competitor.rpc("league_edit_entry",{entry_id:item.id,expected_revision:0,changes:entryChanges(item.entry,{discipline:"distance",ground_elevation_m:101,coaching_requested:true})});
  assert.equal(edited.error,null);assert.equal(item.entry.revision,1);assert.equal(item.entry.status,"pending");
  for(const field of ["time_s","raw_speed_kmh","raw_distance_m","corrected_speed_kmh","corrected_distance_m","scoring_version","wind_snapshot","replay_data","file_hash","jump_at"]) assert.equal(item.entry[field],null,field);
  assert.equal(item.entry.discipline,"distance");assert.equal(item.entry.ground_elevation_m,101);
  assert.equal(item.entry.file_path,item.path);assert.ok(store.files.has(item.path));
  assert.ok((await competitor.rpc("league_edit_entry",{entry_id:item.id,expected_revision:0,changes:entryChanges(item.entry)})).error);
  assert.ok((await organiser.rpc("league_review_entry",{entry_id:item.id,decision:"approved",expected_revision:0})).error);
  const otherId="10000000-0000-4000-8000-000000000002";
  const other=createLeaguePreviewClient(store,"competitor",fetch,undefined,otherId);
  await other.from("league_registrations").insert({user_id:otherId,public_name:"Other pilot",region:"NSW"});
  await organiser.rpc("league_review_registration",{applicant_id:otherId,decision:"approved"});
  assert.ok((await other.rpc("league_edit_entry",{entry_id:item.id,expected_revision:1,changes:entryChanges(item.entry)})).error);
  assert.equal((await organiser.functions.invoke("league-score",{body:{entry_id:item.id}})).error,null);
  assert.ok(item.entry.replay_data);
  assert.equal((await organiser.rpc("league_review_entry",{entry_id:item.id,decision:"approved",expected_revision:1})).error,null);
  assert.ok((await competitor.rpc("league_edit_entry",{entry_id:item.id,expected_revision:1,changes:entryChanges(item.entry)})).error);
});

test("replacement CSV edits retain the entry identity and protect the current file on failure", async () => {
  const store=createPreviewStore(), item=await upload(store);
  const competitor=createLeaguePreviewClient(store,"competitor");
  const path=`${PREVIEW_USER_ID}/${store.rounds[0].id}/${crypto.randomUUID()}.csv`;
  assert.equal((await competitor.storage.from("league-tracks").upload(path,new Blob([trackCsv(80)]))).error,null);
  assert.ok((await competitor.rpc("league_edit_entry",{entry_id:item.id,expected_revision:99,changes:entryChanges(item.entry,{file_path:path})})).error);
  assert.equal(item.entry.file_path,item.path);
  assert.ok((await competitor.storage.from("league-tracks").remove([item.path])).error);
  assert.equal((await competitor.rpc("league_edit_entry",{entry_id:item.id,expected_revision:0,changes:entryChanges(item.entry,{file_path:path})})).error,null);
  assert.equal(item.entry.id,item.id);assert.equal(item.entry.file_path,path);
  assert.equal((await competitor.storage.from("league-tracks").remove([item.path])).error,null);
  assert.ok(store.files.has(path));assert.ok(!store.files.has(item.path));
  store.rounds[0].closes_at=new Date(Date.now()-1000).toISOString();
  assert.ok((await competitor.rpc("league_edit_entry",{entry_id:item.id,expected_revision:1,changes:entryChanges(item.entry)})).error);
  assert.equal(item.entry.revision,1);
});

test("an edit during a weather request prevents the old calculation overwriting the revised entry", async () => {
  const store=createPreviewStore(), item=await upload(store);
  let start!:()=>void, release!:()=>void;
  const started=new Promise<void>(resolve=>{start=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const organiser=createLeaguePreviewClient(store,"organiser",(async (input,init)=>{start();await gate;return weatherFetcher()(input,init);}) as typeof fetch);
  const scoring=organiser.functions.invoke("league-score",{body:{entry_id:item.id}});
  await started;
  const competitor=createLeaguePreviewClient(store,"competitor");
  const edited=await competitor.rpc("league_edit_entry",{entry_id:item.id,expected_revision:0,changes:entryChanges(item.entry,{ground_elevation_m:102})});
  assert.equal(edited.error,null);
  release();
  assert.ok((await scoring).error);
  assert.equal(item.entry.revision,1);assert.equal(item.entry.ground_elevation_m,102);
  assert.equal(item.entry.scoring_version,null);assert.equal(item.entry.corrected_speed_kmh,null);assert.equal(item.entry.raw_speed_kmh,null);
});

test("a replacement is possible at the entry cap without allowing a thirteenth entry", async () => {
  const store=createPreviewStore();
  const items=[];for(let i=0;i<12;i++)items.push(await upload(store));
  const competitor=createLeaguePreviewClient(store,"competitor");
  const path=`${PREVIEW_USER_ID}/${store.rounds[0].id}/${crypto.randomUUID()}.csv`;
  assert.equal((await competitor.storage.from("league-tracks").upload(path,new Blob([trackCsv(60)]))).error,null);
  assert.ok((await competitor.from("league_entries").insert({...items[0].entry,id:crypto.randomUUID(),file_path:path})).error);
  assert.equal((await competitor.rpc("league_edit_entry",{entry_id:items[0].id,expected_revision:0,changes:entryChanges(items[0].entry,{file_path:path})})).error,null);
  assert.equal((await competitor.storage.from("league-tracks").remove([items[0].path])).error,null);
  assert.equal(store.entries.length,12);assert.equal(store.files.size,12);
});

test("four local competitors have independent registration, files and scoreboard identities", async () => {
  const store = createPreviewStore();
  const organiser = createLeaguePreviewClient(store,"organiser",weatherFetcher());
  const { PREVIEW_COMPETITORS } = await import("../src/leaguePreviewClient.ts");
  const clients = PREVIEW_COMPETITORS.map(profile => createLeaguePreviewClient(store,"competitor",weatherFetcher(),undefined,profile.id));
  const round = String(store.rounds[0].id);
  const paths: string[] = [];
  for (const [index, profile] of PREVIEW_COMPETITORS.entries()) {
    const client = clients[index];
    assert.equal((await client.auth.getSession()).data.session?.user.id,profile.id);
    assert.equal((await client.from("league_registrations").insert({user_id:profile.id,public_name:profile.name,region:"NSW"})).error,null);
    const id = crypto.randomUUID(), path = `${profile.id}/${round}/${id}.csv`;
    assert.ok((await client.storage.from("league-tracks").upload(path,new Blob([trackCsv()]))).error);
    await organiser.rpc("league_review_registration",{applicant_id:profile.id,decision:"approved"});
    assert.equal((await client.storage.from("league-tracks").upload(path,new Blob([trackCsv()]))).error,null);
    assert.equal((await client.from("league_entries").insert({id,user_id:profile.id,round_id:round,public_name:profile.name,region:"NSW",discipline:"speed",location_name:"Moruya",ground_elevation_m:100,file_path:path})).error,null);
    assert.equal((await organiser.functions.invoke("league-score",{body:{entry_id:id}})).error,null);
    assert.equal((await organiser.rpc("league_review_entry",{entry_id:id,decision:"approved"})).error,null);
    paths.push(path);
  }
  for (const [index,client] of clients.entries()) {
    const own = (await client.from("league_entries").select("*")).data!;
    assert.equal(own.length,1);assert.equal(own[0].user_id,PREVIEW_COMPETITORS[index].id);
    const other = paths[(index+1)%4];
    assert.ok((await client.storage.from("league-tracks").download(other)).error);
    assert.ok((await client.storage.from("league-tracks").remove([other])).error);
    assert.ok((await client.storage.from("league-tracks").upload(other+".other",new Blob([trackCsv()]))).error);
  }
  const board = (await organiser.rpc("league_round_scoreboard",{selected_round:round})).data as Record<string,unknown>[];
  assert.equal(board.length,4);assert.equal(new Set(board.map(row=>row.competitor_key)).size,4);
  assert.ok(board.every(row=>row.attempt===1));
});

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

test("public scoreboard and lazy replay expose approved relative traces only, with a four-track limit", async () => {
  const store = createPreviewStore();
  const item = await upload(store);
  let weatherCalls = 0;
  const organiser = createLeaguePreviewClient(store,"organiser",weatherFetcher(() => weatherCalls++));
  const visitor = createLeaguePreviewClient(store,"visitor");
  const round = String(store.rounds[0].id);
  assert.deepEqual((await visitor.rpc("league_round_scoreboard",{selected_round:round})).data,[]);
  assert.ok((await visitor.rpc("league_replay_tracks",{entry_ids:[item.id]})).error);
  await organiser.functions.invoke("league-score",{body:{entry_id:item.id}});
  await organiser.rpc("league_review_entry",{entry_id:item.id,decision:"approved"});
  const board = (await visitor.rpc("league_round_scoreboard",{selected_round:round})).data as Record<string,unknown>[];
  assert.equal(board.length,1); assert.equal(board[0].attempt,1);
  assert.equal(board[0].replay_available,true);
  for(const key of ["file_path","wind_snapshot","coaching_note","email","jump_at","replay_data"]) assert.ok(!(key in board[0]));
  assert.ok((await visitor.storage.from("league-tracks").download(item.path)).error);
  // Legacy approved entries can derive replay from saved winds without fetching new weather.
  delete item.entry.replay_data;
  const publicReplay = await visitor.rpc("league_replay_tracks",{entry_ids:[item.id]});
  assert.equal(publicReplay.error,null);
  assert.equal(weatherCalls,1);
  const serialised = JSON.stringify(publicReplay.data);
  assert.ok(!serialised.includes('"lat"'));assert.ok(!serialised.includes('"lon"'));
  assert.ok(!serialised.includes("timestampMs"));assert.ok(!serialised.includes(item.path));
  assert.ok((await visitor.rpc("league_replay_tracks",{entry_ids:[]})).error);
  assert.ok((await visitor.rpc("league_replay_tracks",{entry_ids:[item.id,item.id]})).error);
  assert.ok((await visitor.rpc("league_replay_tracks",{entry_ids:[item.id,"a","b","c","d"]})).error);
  const additional = Array.from({length:3}, () => ({...item.entry,id:crypto.randomUUID()}));
  store.entries.push(...additional);
  const four = await visitor.rpc("league_replay_tracks",{entry_ids:[item.id,...additional.map(row=>row.id)]});
  assert.equal(four.error,null);assert.equal((four.data as unknown[]).length,4);
  await organiser.rpc("league_review_entry",{entry_id:item.id,decision:"rejected"});
  assert.equal(((await visitor.rpc("league_round_scoreboard",{selected_round:round})).data as unknown[]).length,3);
  assert.ok((await visitor.rpc("league_replay_tracks",{entry_ids:[item.id]})).error);
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
  assert.equal(item.entry.time_s, 50);
  assert.ok(Math.abs(Number(item.entry.raw_speed_kmh) - 180) < 0.001);
  assert.ok(Math.abs(Number(item.entry.raw_distance_m) - 2500) < 0.001);
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
