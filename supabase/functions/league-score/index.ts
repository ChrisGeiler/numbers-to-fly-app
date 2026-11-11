import { createClient } from "npm:@supabase/supabase-js@2.108.2";
import {
  fetchLeagueWinds,
  leagueWindow,
  scoreLeagueWindow,
} from "../../../src/leagueScoring.ts";
import { buildLeagueReplay } from "../../../src/leagueReplay.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (request) => {
  if (request.method === "OPTIONS")
    return new Response("ok", { headers: cors });
  if (request.method !== "POST") return reply(405, { error: "POST required" });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const auth = request.headers.get("Authorization");
    if (!auth?.startsWith("Bearer "))
      return reply(401, { error: "Sign in to review entries." });
    const viewer = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false },
    });
    const { data: identity, error: authError } = await viewer.auth.getUser();
    if (authError || !identity.user)
      return reply(401, { error: "Sign in to review entries." });
    const { data: isOwner, error: ownerError } = await viewer.rpc(
      "current_user_is_app_owner",
    );
    if (ownerError || isOwner !== true)
      return reply(403, {
        error: "Only the league organiser can calculate official results.",
      });
    const body = await request.text();
    if (body.length > 2000) return reply(400, { error: "Invalid request" });
    const { entry_id } = JSON.parse(body);
    if (typeof entry_id !== "string" || !/^[0-9a-f-]{36}$/.test(entry_id))
      return reply(400, { error: "Invalid entry" });
    const admin = createClient(
      url,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const { data: entry, error } = await admin
      .from("league_entries")
      .select("*")
      .eq("id", entry_id)
      .single();
    if (error || !entry) return reply(404, { error: "Entry not found" });
    if (entry.status !== "pending")
      return reply(409, { error: "Only pending entries can be calculated." });
    if (entry.scoring_version)
      return reply(200, {
        message: "Scores already calculated. Review the saved result.",
      });
    const roundResponse = await admin
      .from("league_rounds")
      .select("opens_at,closes_at,published")
      .eq("id", entry.round_id)
      .single();
    const round = roundResponse.data;
    if (!round?.published) throw new Error("Round is not published.");
    const prefix = `${entry.user_id}/${entry.round_id}/`;
    if (!entry.file_path.startsWith(prefix) || !/^[0-9a-f-]{36}[.]csv$/.test(entry.file_path.slice(prefix.length)))
      throw new Error("Invalid original file path.");
    const download = await admin.storage
      .from("league-tracks")
      .download(entry.file_path);
    if (download.error || !download.data)
      throw new Error("Original track is unavailable.");
    if (download.data.size > 8388608) throw new Error("Track exceeds 8 MB.");
    const buffer = await download.data.arrayBuffer();
    const file_hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const points = leagueWindow(
      new TextDecoder().decode(buffer),
      entry.ground_elevation_m,
    );
    if (
      points[0].timestampMs! < Date.parse(round.opens_at) ||
      points.at(-1)!.timestampMs! >= Date.parse(round.closes_at) ||
      points.at(-1)!.timestampMs! > Date.parse(entry.submitted_at)
    )
      throw new Error(
        "Jump must occur within the round and before submission.",
      );
    const winds = await fetchLeagueWinds(points);
    const scores = scoreLeagueWindow(points, winds);
    const update = await admin
      .from("league_entries")
      .update({ ...scores, wind_snapshot: winds, file_hash,
        replay_data: buildLeagueReplay(new TextDecoder().decode(buffer), entry.ground_elevation_m, winds) })
      .eq("id", entry.id)
      .eq("status", "pending")
      .eq("revision", entry.revision ?? 0)
      .is("scoring_version", null)
      .select("id");
    if (update.error)
      throw new Error(
        update.error.code === "23505"
          ? "This original file has already been scored in this discipline and round."
          : update.error.message,
      );
    if (!update.data?.length)
      return reply(409, {
        error: "Entry changed during scoring. Refresh the review desk.",
      });
    return reply(200, { ...scores, model: winds.model });
  } catch (error) {
    return reply(400, {
      error:
        error instanceof Error
          ? error.message
          : "Scoring failed. Entry remains pending.",
    });
  }
});
