// LOCAL_LEAGUE_PREVIEW_ONLY: UI fixtures, never an authentication bypass.
// Supabase data/auth remain local. Weather lookup and GPS scoring are real.
import type { supabase } from "./supabase";
import {
  leagueWindow,
  fetchLeagueWinds,
  scoreLeagueWindow,
  LEAGUE_SCORING_VERSION,
  LEAGUE_WIND_MODEL,
} from "./leagueScoring.ts";

export type PreviewRole = "visitor" | "competitor" | "organiser";
type Row = Record<string, unknown>;
type Reply = { data: unknown; error: { message: string } | null };
export const PREVIEW_USER_ID = "10000000-0000-4000-8000-000000000001";
const ROUND_ID = "20000000-0000-4000-8000-000000000001";
const ok = (data: unknown = null): Reply => ({ data, error: null });
const fail = (message: string): Reply => ({ data: null, error: { message } });

export function createPreviewStore() {
  const now = new Date();
  const opens = "2022-01-01T00:00:00.000Z";
  const closes = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    1,
  ).toISOString();
  const round = {
    id: ROUND_ID,
    title: "Local scoring test round",
    opens_at: opens,
    closes_at: closes,
    published: true,
  };
  const rows: Row[] = [];
  return {
    instanceId: crypto.randomUUID(),
    persist: undefined as (() => Promise<void>) | undefined,
    rounds: [round] as Row[],
    registrations: [] as Row[],
    entries: rows,
    files: new Map<string, Blob>(),
  };
}
export type PreviewStore = ReturnType<typeof createPreviewStore>;

export function createLeaguePreviewClient(
  store: PreviewStore,
  role: PreviewRole,
  fetcher: typeof fetch = fetch,
): typeof supabase {
  const organiser = role === "organiser";
  let signedIn = role !== "visitor";
  const session = () =>
    signedIn
      ? { user: { id: PREVIEW_USER_ID, email: `${role}@preview.invalid` } }
      : null;
  const canSubmit = () =>
    signedIn &&
    (organiser ||
      store.registrations.some(
        (row) => row.user_id === PREVIEW_USER_ID && row.status === "approved",
      ));
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
            : this.table === "league_registrations"
              ? store.registrations
              : null;
      if (!rows)
        return fail("This local preview does not access other tables.");
      const matches = (row: Row) =>
        this.filters.every(([column, value]) => row[column] === value);
      if (this.operation === "insert") {
        if (!signedIn || (this.table === "league_rounds" && !organiser))
          return fail("Choose the organiser preview to create rounds.");
        if (this.table === "league_registrations") {
          if (
            this.payload.user_id !== PREVIEW_USER_ID ||
            Object.keys(this.payload).some(
              (key) => !["user_id", "public_name", "region"].includes(key),
            )
          )
            return fail(
              "Request your own registration without assigning approval fields.",
            );
          if (
            store.registrations.some((row) => row.user_id === PREVIEW_USER_ID)
          )
            return fail("Your registration has already been requested.");
          if (
            String(this.payload.public_name ?? "").trim().length < 2 ||
            String(this.payload.public_name).length > 60 ||
            !["ACT", "NSW", "NT", "QLD", "SA", "VIC", "WA"].includes(
              String(this.payload.region),
            )
          )
            return fail("Enter your name and home state.");
        }
        if (this.table === "league_entries") {
          if (!canSubmit())
            return fail(
              "Your league registration must be approved before entering a round.",
            );
          const round = store.rounds.find(
            (row) => row.id === this.payload.round_id,
          );
          if (
            this.payload.user_id !== PREVIEW_USER_ID ||
            !store.files.has(String(this.payload.file_path))
          )
            return fail(
              "Upload your original file before submitting the entry.",
            );
          if (
            !round?.published ||
            Date.now() < Date.parse(String(round.opens_at)) ||
            Date.now() >= Date.parse(String(round.closes_at))
          )
            return fail("This round is not accepting entries.");
        }
        rows.push({
          id: crypto.randomUUID(),
          status: "pending",
          submitted_at: new Date().toISOString(),
          requested_at: new Date().toISOString(),
          email: session()?.user.email ?? "",
          coaching_note: null,
          review_note: null,
          ...this.payload,
        });
        await store.persist?.();
        return ok();
      }
      if (this.operation === "update") {
        if (!organiser || this.table !== "league_rounds")
          return fail("This preview action requires the organiser view.");
        if (rows.some((row) => matches(row) && row.published))
          return fail(
            "Published rounds are locked. Create a new round instead.",
          );
        rows.filter(matches).forEach((row) => Object.assign(row, this.payload));
        await store.persist?.();
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
      if (name === "league_review_registration") {
        const applicant = store.registrations.find(
          (row) => row.user_id === args.applicant_id,
        );
        if (
          !applicant ||
          !["approved", "rejected"].includes(String(args.decision))
        )
          return fail("Invalid registration review.");
        Object.assign(applicant, {
          status: args.decision,
          review_note: String(args.note ?? "").slice(0, 2000),
          reviewed_at: new Date().toISOString(),
        });
        await store.persist?.();
        return ok();
      }
      const entry = store.entries.find((row) => row.id === args.entry_id);
      if (!entry) return fail("Preview entry not found.");
      if (name === "league_review_entry") {
        if (!["approved", "rejected"].includes(String(args.decision)))
          return fail("Invalid review decision.");
        if (
          args.decision === "approved" &&
          (entry.scoring_version !== LEAGUE_SCORING_VERSION ||
            !(entry.wind_snapshot as { model?: string })?.model ||
            (entry.wind_snapshot as { model: string }).model !==
              LEAGUE_WIND_MODEL)
        )
          return fail(
            "Calculate wind-corrected scores from the original track before approving.",
          );
        if (args.decision === "approved" && entry.round_eligible !== true)
          return fail(
            "The jump is outside this round’s dates and cannot be approved.",
          );
        entry.status = args.decision;
        entry.review_note = args.note;
        await store.persist?.();
        return ok();
      }
      if (name === "league_coaching_note") {
        entry.coaching_note = args.note;
        await store.persist?.();
        return ok();
      }
      return fail("This action is not part of the local preview.");
    },
    storage: {
      from: () => ({
        upload: async (path: string, file: Blob) => {
          if (!signedIn) return fail("Choose a signed-in preview role.");
          if (!canSubmit())
            return fail(
              "Your league registration must be approved before uploading a track.",
            );
          const [userId, roundId] = path.split("/");
          const round = store.rounds.find((row) => row.id === roundId);
          if (
            userId !== PREVIEW_USER_ID ||
            !round?.published ||
            Date.now() < Date.parse(String(round.opens_at)) ||
            Date.now() >= Date.parse(String(round.closes_at))
          )
            return fail("Upload requires your own folder and an open round.");
          if (file.size === 0 || file.size > 8388608)
            return fail("Choose a FlySight CSV smaller than 8 MB.");
          if (store.files.has(path))
            return fail("Original tracks cannot be replaced.");
          const folder = path.split("/").slice(0, 2).join("/") + "/";
          if (
            [...store.files.keys()].filter((key) => key.startsWith(folder))
              .length >= 12
          )
            return fail("Maximum 12 tracks per round.");
          store.files.set(path, file);
          await store.persist?.();
          return ok({ path });
        },
        remove: async (paths: string[]) => {
          paths.forEach((path) => store.files.delete(path));
          await store.persist?.();
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
            "Choose the organiser test view to calculate wind-corrected scores.",
          );
        const entry = store.entries.find(
          (row) => row.id === options.body.entry_id,
        );
        if (!entry) return fail("Preview entry not found.");
        if (_name !== "league-score") return fail("Unsupported test function.");
        if (entry.status !== "pending")
          return fail("Only pending entries can be calculated.");
        if (entry.scoring_version === LEAGUE_SCORING_VERSION)
          return ok({
            message:
              "Previously calculated result retained with its saved winds.",
          });
        try {
          const original = store.files.get(String(entry.file_path));
          if (!original)
            return fail(
              "Original GPS file is missing. Upload a track to test real scoring.",
            );
          const buffer = await original.arrayBuffer();
          const file_hash = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
            (b) => b.toString(16).padStart(2, "0"),
          ).join("");
          if (
            store.entries.some(
              (other) =>
                other.id !== entry.id &&
                other.user_id === entry.user_id &&
                other.round_id === entry.round_id &&
                other.discipline === entry.discipline &&
                other.file_hash === file_hash,
            )
          )
            return fail(
              "This original file has already been scored in this task and round.",
            );
          const points = leagueWindow(
            new TextDecoder().decode(buffer),
            Number(entry.ground_elevation_m),
          );
          const wind_snapshot = await fetchLeagueWinds(points, fetcher);
          const scores = scoreLeagueWindow(points, wind_snapshot);
          const round = store.rounds.find((row) => row.id === entry.round_id);
          const round_eligible =
            !!round &&
            points[0].timestampMs! >= Date.parse(String(round.opens_at)) &&
            points.at(-1)!.timestampMs! < Date.parse(String(round.closes_at)) &&
            points.at(-1)!.timestampMs! <=
              Date.parse(String(entry.submitted_at));
          Object.assign(entry, {
            ...scores,
            wind_snapshot,
            file_hash,
            round_eligible,
          });
          await store.persist?.();
          return ok({ ...scores, model: wind_snapshot.model });
        } catch (error) {
          return fail(
            error instanceof Error
              ? error.message
              : "Could not calculate this track. It remains pending.",
          );
        }
      },
    },
  };
  // The adapter implements only the methods this UI uses. It cannot create or
  // transmit a real auth session; server permissions remain completely unchanged.
  return client as unknown as typeof supabase;
}
