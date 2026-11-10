// LOCAL_LEAGUE_PREVIEW_ONLY: UI fixtures, never an authentication bypass.
// This adapter has no network client, credentials or connection to Supabase.
import type { supabase } from "./supabase";

export type PreviewRole = "visitor" | "competitor" | "organiser";
type Row = Record<string, unknown>;
type Reply = { data: unknown; error: { message: string } | null };
export const PREVIEW_USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000002";
const ROUND_ID = "20000000-0000-4000-8000-000000000001";
const ok = (data: unknown = null): Reply => ({ data, error: null });
const fail = (message: string): Reply => ({ data: null, error: { message } });

export function createPreviewStore() {
  const now = new Date();
  const opens = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const closes = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    1,
  ).toISOString();
  const round = {
    id: ROUND_ID,
    title: "Sample monthly round",
    opens_at: opens,
    closes_at: closes,
    published: true,
  };
  const rows: Row[] = ["speed", "time", "distance"].flatMap((discipline, i) => [
    {
      id: `30000000-0000-4000-8000-00000000000${i + 1}`,
      user_id: OTHER_USER_ID,
      round_id: ROUND_ID,
      public_name: "Alex · sample competitor",
      region: "NSW",
      discipline,
      location_name: "Sample drop zone",
      ground_elevation_m: 100,
      file_path: "sample-only.csv",
      submitted_at: now.toISOString(),
      status: "approved",
      time_s: 42 + i * 2,
      raw_distance_m: 2700,
      raw_speed_kmh: 230,
      corrected_distance_m: 2500,
      corrected_speed_kmh: 214,
      scoring_version: "sample-preview",
      coaching_requested: false,
      coaching_note: null,
      review_note: "Sample approved result",
    },
  ]);
  rows.push({
    id: "30000000-0000-4000-8000-000000000009",
    user_id: PREVIEW_USER_ID,
    round_id: ROUND_ID,
    public_name: "Sam · sample competitor",
    region: "VIC",
    discipline: "distance",
    location_name: "Sample drop zone",
    ground_elevation_m: 100,
    file_path: "sample-only.csv",
    submitted_at: now.toISOString(),
    status: "pending",
    time_s: null,
    raw_distance_m: null,
    raw_speed_kmh: null,
    corrected_distance_m: null,
    corrected_speed_kmh: null,
    scoring_version: null,
    coaching_requested: true,
    coaching_note: null,
    review_note: null,
  });
  return {
    rounds: [round] as Row[],
    entries: rows,
    files: new Map<string, Blob>(),
  };
}
export type PreviewStore = ReturnType<typeof createPreviewStore>;

export function createLeaguePreviewClient(
  store: PreviewStore,
  role: PreviewRole,
): typeof supabase {
  const organiser = role === "organiser";
  let signedIn = role !== "visitor";
  const session = () =>
    signedIn
      ? { user: { id: PREVIEW_USER_ID, email: `${role}@preview.invalid` } }
      : null;
  const subscribers = new Set<(event: string, session: unknown) => void>();
  class Query {
    filters: [string, unknown][] = [];
    cap = Infinity;
    sort: { column: string; ascending: boolean } | null = null;
    operation = "select";
    payload: Row = {};
    readonly table: string;
    constructor(table: string) {
      this.table = table;
    }
    select(_columns?: string) {
      void _columns;
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.push([column, value]);
      return this;
    }
    order(column: string, options?: { ascending: boolean }) {
      this.sort = { column, ascending: options?.ascending ?? true };
      return this;
    }
    limit(cap: number) {
      this.cap = cap;
      return this;
    }
    insert(row: Row) {
      this.operation = "insert";
      this.payload = row;
      return this;
    }
    update(row: Row) {
      this.operation = "update";
      this.payload = row;
      return this;
    }
    async run(): Promise<Reply> {
      const rows =
        this.table === "league_rounds"
          ? store.rounds
          : this.table === "league_entries"
            ? store.entries
            : null;
      if (!rows)
        return fail("This local preview does not access other tables.");
      const matches = (row: Row) =>
        this.filters.every(([column, value]) => row[column] === value);
      if (this.operation === "insert") {
        if (!signedIn || (this.table === "league_rounds" && !organiser))
          return fail("Choose the organiser preview to create rounds.");
        rows.push({
          id: crypto.randomUUID(),
          status: "pending",
          submitted_at: new Date().toISOString(),
          coaching_note: null,
          review_note: null,
          ...this.payload,
        });
        return ok();
      }
      if (this.operation === "update") {
        if (!organiser || this.table !== "league_rounds")
          return fail("This preview action requires the organiser view.");
        rows.filter(matches).forEach((row) => Object.assign(row, this.payload));
        return ok();
      }
      let visible = rows
        .filter(matches)
        .filter((row) =>
          this.table === "league_rounds"
            ? organiser || row.published
            : signedIn && (organiser || row.user_id === PREVIEW_USER_ID),
        );
      if (this.sort) {
        const { column, ascending } = this.sort;
        visible = [...visible].sort(
          (a, b) =>
            String(a[column]).localeCompare(String(b[column])) *
            (ascending ? 1 : -1),
        );
      }
      return ok(visible.slice(0, this.cap).map((row) => ({ ...row })));
    }
    then<T = Reply, U = never>(
      resolve?: ((value: Reply) => T | PromiseLike<T>) | null,
      reject?: ((reason: unknown) => U | PromiseLike<U>) | null,
    ): Promise<T | U> {
      return this.run().then(resolve, reject);
    }
  }
  const client = {
    auth: {
      getSession: async () => ({ data: { session: session() }, error: null }),
      onAuthStateChange: (
        callback: (event: string, session: unknown) => void,
      ) => {
        subscribers.add(callback);
        return {
          data: {
            subscription: { unsubscribe: () => subscribers.delete(callback) },
          },
        };
      },
      signOut: async () => {
        signedIn = false;
        subscribers.forEach((fn) => fn("SIGNED_OUT", null));
        return { error: null };
      },
      signInWithOtp: async () =>
        fail(
          "Use the preview role buttons. No emails are sent in local preview.",
        ),
      verifyOtp: async () =>
        fail(
          "Use the preview role buttons. No real login happens in local preview.",
        ),
    },
    from: (table: string) => new Query(table),
    rpc: async (name: string, args: Row = {}): Promise<Reply> => {
      if (name === "current_user_is_app_owner")
        return ok(signedIn && organiser);
      // A preview role must never display a link implying real training-app access.
      if (name === "current_user_has_app_access") return ok(false);
      if (name === "league_leaderboard") {
        const best = new Map<string, Row>();
        store.entries
          .filter(
            (row) =>
              row.round_id === args.selected_round && row.status === "approved",
          )
          .forEach((row) => {
            const key = `${row.user_id}/${row.discipline}`;
            const metric =
              row.discipline === "speed"
                ? "corrected_speed_kmh"
                : row.discipline === "distance"
                  ? "corrected_distance_m"
                  : "time_s";
            if (
              !best.has(key) ||
              Number(row[metric]) > Number(best.get(key)![metric])
            )
              best.set(key, row);
          });
        return ok(
          [...best.values()].map((row) => ({
            ...row,
            competitor_key: row.user_id,
          })),
        );
      }
      if (!signedIn || !organiser)
        return fail("Choose the organiser preview for this action.");
      const entry = store.entries.find((row) => row.id === args.entry_id);
      if (!entry) return fail("Preview entry not found.");
      if (name === "league_review_entry") {
        if (args.decision === "approved" && !entry.scoring_version)
          return fail("Calculate the sample scores before approving.");
        entry.status = args.decision;
        entry.review_note = args.note;
        return ok();
      }
      if (name === "league_coaching_note") {
        entry.coaching_note = args.note;
        return ok();
      }
      return fail("This action is not part of the local preview.");
    },
    storage: {
      from: () => ({
        upload: async (path: string, file: Blob) => {
          if (!signedIn) return fail("Choose a signed-in preview role.");
          store.files.set(path, file);
          return ok({ path });
        },
        remove: async (paths: string[]) => {
          paths.forEach((path) => store.files.delete(path));
          return ok();
        },
        download: async (path: string) =>
          store.files.has(path)
            ? ok(store.files.get(path))
            : fail(
                "This sample entry has no original GPS file. Upload your own file in the competitor preview to test downloads.",
              ),
      }),
    },
    functions: {
      invoke: async (
        _name: string,
        options: { body: { entry_id: string } },
      ) => {
        if (!signedIn || !organiser)
          return fail(
            "Choose the organiser preview to calculate sample scores.",
          );
        const entry = store.entries.find(
          (row) => row.id === options.body.entry_id,
        );
        if (!entry) return fail("Preview entry not found.");
        Object.assign(entry, {
          time_s: 40,
          raw_distance_m: 2750,
          raw_speed_kmh: 247.5,
          corrected_distance_m: 2380,
          corrected_speed_kmh: 214.2,
          scoring_version: "sample-preview",
        });
        return ok({
          message: "Sample scores only; no weather API was called.",
        });
      },
    },
  };
  // The adapter implements only the methods this UI uses. It cannot create or
  // transmit a real auth session; server permissions remain completely unchanged.
  return client as unknown as typeof supabase;
}
