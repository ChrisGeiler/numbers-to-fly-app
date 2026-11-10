import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { leagueWindow } from "./leagueScoring";
import LeagueGoogleSignIn from "./LeagueGoogleSignIn";
import {
  calculateLeagueUploadScores,
  measureLeagueUploadWindow,
} from "./leagueUploadScore";

type Round = {
  id: string;
  title: string;
  opens_at: string;
  closes_at: string;
  published: boolean;
};
type Result = {
  competitor_key: string;
  public_name: string;
  region: string;
  discipline: string;
  time_s: number;
  corrected_speed_kmh: number;
  corrected_distance_m: number;
  raw_speed_kmh: number;
  raw_distance_m: number;
};
type Entry = Result & {
  id: string;
  round_id: string;
  status: string;
  location_name: string;
  ground_elevation_m: number;
  file_path: string;
  submitted_at: string;
  coaching_requested: boolean;
  coaching_note: string | null;
  review_note: string | null;
  scoring_version: string | null;
  jump_at?: string | null;
  file_hash?: string | null;
  wind_snapshot?: { model: string; fetched_at: string } | null;
  round_eligible?: boolean;
};
const emailSignInEnabled =
  import.meta.env.VITE_LEAGUE_EMAIL_SIGN_IN_ENABLED === "true";
const regions = ["ACT", "NSW", "NT", "QLD", "SA", "VIC", "WA"];
const HOME_STATE_STORAGE_KEY = "ntf-league-home-state";
const dropZones = [
  "ADELAIDE SKYDIVING CENTRE",
  "AIRLIE BEACH SKYDIVERS",
  "COASTAL SKYDIVE SA",
  "COMMANDO SKYDIVERS INCORPORATED",
  "FAR NORTH FREEFALL CLUB INC.",
  "HILLMAN FARM SKYDIVERS",
  "NEWCASTLE SPORT PARACHUTE CLUB",
  "RAMBLERS PARACHUTE CENTRE",
  "SA SKYDIVING OPS",
  "SKYDIVE BYRON BAY",
  "SKYDIVE GREAT OCEAN ROAD",
  "SKYDIVE JURIEN BAY",
  "Moruya",
  "TORQUAY SKYDIVERS",
  "DARWIN PARACHUTE CLUB",
];
const disciplines = ["speed", "time", "distance"] as const;
type Discipline = (typeof disciplines)[number];
type UploadMetrics = ReturnType<typeof calculateLeagueUploadScores>;
const fmt = (value: number | null | undefined, decimals = 1) =>
  value == null ? "—" : value.toFixed(decimals);
const date = (value: string) =>
  new Date(value).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const score = (row: Result, discipline: string) =>
  discipline === "speed"
    ? row.corrected_speed_kmh
    : discipline === "distance"
      ? row.corrected_distance_m
      : row.time_s;

export default function League({
  client = supabase,
  preview = false,
}: {
  client?: typeof supabase;
  preview?: boolean;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [owner, setOwner] = useState(false);
  const [appAccess, setAppAccess] = useState(false);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [roundId, setRoundId] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [entryLimit, setEntryLimit] = useState(200);
  const [tab, setTab] = useState("overall");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Discipline>("speed");
  const [groundElevation, setGroundElevation] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadMetrics, setUploadMetrics] = useState<UploadMetrics | null>(
    null,
  );
  const [uploadScoreStatus, setUploadScoreStatus] = useState("");
  const [calculatingUpload, setCalculatingUpload] = useState(false);
  const [lastSubmission, setLastSubmission] = useState<{
    task: Discipline;
    metrics: UploadMetrics;
    filename: string;
  } | null>(null);
  const [homeState, setHomeState] = useState(() => {
    try {
      const saved = window.localStorage.getItem(HOME_STATE_STORAGE_KEY);
      return saved && regions.includes(saved) ? saved : "";
    } catch {
      return "";
    }
  });
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [authStatus, setAuthStatus] = useState("");
  const [note, setNote] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const epoch = useRef(0);
  const refreshId = useRef(0);
  useEffect(() => {
    let cancelled = false;
    setUploadMetrics(null);
    setCalculatingUpload(false);
    setUploadScoreStatus("");
    if (!uploadFile) return;
    if (!groundElevation.trim()) {
      setUploadScoreStatus(
        "Enter the drop zone elevation to calculate your task score.",
      );
      return;
    }
    if (uploadFile.size === 0 || uploadFile.size > 8 * 1024 * 1024) {
      setUploadScoreStatus("Choose a FlySight CSV smaller than 8 MB.");
      return;
    }
    setCalculatingUpload(true);
    void uploadFile
      .text()
      .then((csv) => {
        if (cancelled) return;
        const metrics = calculateLeagueUploadScores(
          csv,
          Number(groundElevation),
        );
        if (!cancelled) setUploadMetrics(metrics);
      })
      .catch((error) => {
        if (!cancelled)
          setUploadScoreStatus(
            error instanceof Error
              ? error.message
              : "Could not calculate this track's score.",
          );
      })
      .finally(() => {
        if (!cancelled) setCalculatingUpload(false);
      });
    return () => {
      cancelled = true;
    };
  }, [uploadFile, groundElevation]);
  const displayedUploadMetrics = uploadFile
    ? uploadMetrics
    : lastSubmission?.metrics;
  const displayedUploadTask = uploadFile
    ? selectedTask
    : (lastSubmission?.task ?? selectedTask);
  const displayedUploadValue =
    displayedUploadMetrics &&
    (displayedUploadTask === "speed"
      ? displayedUploadMetrics.speedKmh
      : displayedUploadTask === "time"
        ? displayedUploadMetrics.timeSeconds
        : displayedUploadMetrics.distanceMetres);
  useEffect(() => {
    setEntryLimit(200);
  }, [roundId]);
  const round = rounds.find((r) => r.id === roundId);
  const accepting =
    !!round?.published &&
    Date.now() >= Date.parse(round.opens_at) &&
    Date.now() < Date.parse(round.closes_at);

  useEffect(() => {
    void client.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = client.auth.onAuthStateChange((_event, next) =>
      setSession(next),
    );
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const id = ++epoch.current;
    setOwner(false);
    setAppAccess(false);
    setEntries([]);
    setNote({});
    setFeedback({});
    if (!session) return;
    void Promise.all([
      client.rpc("current_user_is_app_owner"),
      client.rpc("current_user_has_app_access"),
    ]).then(([a, b]) => {
      if (id !== epoch.current) return;
      setOwner(a.data === true);
      setAppAccess(b.data === true);
    });
  }, [session?.user.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    void client
      .from("league_rounds")
      .select("id,title,opens_at,closes_at,published")
      .order("opens_at", { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setStatus(
            "League setup is not available yet. Please check back shortly.",
          );
          return;
        }
        const list = (data ?? []) as Round[];
        setRounds(list);
        setRoundId((current) =>
          list.some((r) => r.id === current)
            ? current
            : ((
                list.find(
                  (r) => r.published && Date.parse(r.closes_at) > Date.now(),
                ) ?? list[0]
              )?.id ?? ""),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [owner]);

  const refresh = useCallback(async () => {
    const requestId = ++refreshId.current;
    if (!roundId) {
      setResults([]);
      setEntries([]);
      return;
    }
    const currentEpoch = epoch.current;
    const { data, error } = await client.rpc("league_leaderboard", {
      selected_round: roundId,
    });
    if (currentEpoch !== epoch.current || requestId !== refreshId.current)
      return;
    if (error) {
      setStatus(error.message);
      return;
    }
    setResults((data ?? []) as Result[]);
    if (session) {
      let query = client
        .from("league_entries")
        .select(
          "id,round_id,public_name,region,discipline,status,location_name,ground_elevation_m,file_path,submitted_at,coaching_requested,coaching_note,review_note,time_s,corrected_speed_kmh,corrected_distance_m,raw_speed_kmh,raw_distance_m,scoring_version,jump_at,file_hash,wind_snapshot",
        )
        .eq("round_id", roundId)
        .order("submitted_at", { ascending: false })
        .limit(entryLimit);
      if (!owner) query = query.eq("user_id", session.user.id);
      const response = await query;
      if (currentEpoch !== epoch.current || requestId !== refreshId.current)
        return;
      if (response.error) setStatus(response.error.message);
      else setEntries((response.data ?? []) as Entry[]);
    } else setEntries([]);
  }, [roundId, session?.user.id, owner, entryLimit]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void refresh();
    return () => {
      refreshId.current++;
    };
  }, [refresh]);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setAuthStatus("");
    const { error } = await client.auth.signInWithOtp({
      email: email.trim(),
      options: {
        shouldCreateUser: true,
        emailRedirectTo: new URL("league.html", window.location.origin).href,
      },
    });
    setAuthStatus(
      error
        ? error.message
        : "Check your email for a sign-in link. If your email includes a code, enter it below.",
    );
    setBusy(false);
  }
  async function verifyCode() {
    setBusy(true);
    const { error } = await client.auth.verifyOtp({
      email: email.trim(),
      token: otp.trim(),
      type: "email",
    });
    setAuthStatus(error?.message ?? "Signed in.");
    setBusy(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !round || !accepting) return;
    const form = new FormData(event.currentTarget);
    const file = form.get("track") as File;
    setBusy(true);
    setStatus("Checking your track…");
    let path = "";
    let submitted = false;
    try {
      if (!file?.size || file.size > 8 * 1024 * 1024)
        throw new Error("Choose a FlySight CSV smaller than 8 MB.");
      const ground = Number(form.get("ground"));
      const window = leagueWindow(await file.text(), ground);
      if (
        !preview &&
        (window[0].timestampMs! < Date.parse(round.opens_at) ||
          window.at(-1)!.timestampMs! >= Date.parse(round.closes_at))
      )
        throw new Error("The jump must take place within this round's dates.");
      const id = crypto.randomUUID();
      path = `${session.user.id}/${round.id}/${id}.csv`;
      setStatus("Uploading your private track…");
      const upload = await client.storage
        .from("league-tracks")
        .upload(path, file, { contentType: "text/csv", upsert: false });
      if (upload.error) throw upload.error;
      const { error } = await client.from("league_entries").insert({
        id,
        user_id: session.user.id,
        round_id: round.id,
        public_name: String(form.get("name")).trim(),
        region: form.get("region"),
        discipline: form.get("discipline"),
        location_name: String(form.get("location")).trim(),
        ground_elevation_m: ground,
        file_path: path,
        coaching_requested: form.get("coaching") === "on",
      });
      if (error) throw error;
      submitted = true;
      setLastSubmission({
        task: selectedTask,
        metrics: measureLeagueUploadWindow(window),
        filename: file.name,
      });
      formRef.current?.reset();
      setUploadFile(null);
      setGroundElevation("");
      setSelectedTask("speed");
      let message =
        "Entry received. Your track is private and your result is pending review.";
      if (preview && owner) {
        setStatus(
          "Track received. Fetching archived GFS winds and calculating your result…",
        );
        const calculation = await client.functions.invoke("league-score", {
          body: { entry_id: id },
        });
        message = calculation.error
          ? `Entry received; wind correction could not complete: ${calculation.error.message}. Retry from the review desk.`
          : "Wind-corrected result calculated from your original track. Review it below before approving.";
      }
      setStatus(message);
      await refresh();
    } catch (error) {
      if (path && !submitted)
        await client.storage.from("league-tracks").remove([path]);
      setStatus(
        error instanceof Error
          ? error.message
          : String(
              (error as { message?: string }).message ??
                "Upload failed. Please retry.",
            ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function act(
    action: () => Promise<{ error: { message: string } | null }>,
    success: string,
    progress = "Working…",
  ) {
    setBusy(true);
    setStatus(progress);
    try {
      const response = await action();
      if (response.error) {
        const context = (response.error as { context?: Response }).context;
        const detail = context ? await context.json().catch(() => null) : null;
        throw new Error(detail?.error ?? response.error.message);
      }
      setStatus(preview ? `Local test: ${success}` : success);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Please retry.");
    } finally {
      setBusy(false);
    }
  }

  async function createRound(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await act(async () => {
      const opens = new Date(String(form.get("opens"))),
        closes = new Date(String(form.get("closes")));
      if (!(closes > opens))
        throw new Error("The closing date must be after the opening date.");
      return await client.from("league_rounds").insert({
        title: String(form.get("title")).trim(),
        opens_at: opens.toISOString(),
        closes_at: closes.toISOString(),
        published: false,
      });
    }, "Draft round created. Check the dates before publishing.");
    const { data } = await client
      .from("league_rounds")
      .select("id,title,opens_at,closes_at,published")
      .order("opens_at", { ascending: false });
    if (data) {
      setRounds(data);
      setRoundId(data[0]?.id ?? "");
    }
  }

  const ranked = results
    .filter((r) => r.discipline === tab)
    .sort((a, b) => score(b, tab) - score(a, tab));
  const totals = new Map<
    string,
    { name: string; region: string; points: number; tasks: number }
  >();
  disciplines.forEach((d) => {
    const rows = results.filter((r) => r.discipline === d),
      best = Math.max(0, ...rows.map((r) => score(r, d)));
    rows.forEach((r) => {
      const item = totals.get(r.competitor_key) ?? {
        name: r.public_name,
        region: r.region,
        points: 0,
        tasks: 0,
      };
      item.points += best ? (1000 * score(r, d)) / best : 0;
      item.tasks++;
      totals.set(r.competitor_key, item);
    });
  });
  const overall = [...totals.entries()].sort(
    (a, b) => b[1].points - a[1].points,
  );

  return (
    <div className="league">
      <header className="league-header">
        <a
          className="league-brand"
          href="/league.html"
          aria-label="Australian Wingsuit League home"
        >
          <span className="league-mark">
            W<span>/</span>L
          </span>
          <span>
            AUSTRALIAN
            <br />
            <b>WINGSUIT LEAGUE</b>
          </span>
        </a>
        <nav aria-label="League navigation">
          <a href="#standings">Standings</a>
          <a href="#how">How it works</a>
          <a href="#coaching">Coaching</a>
          {appAccess && <a href="/">Numbers to Fly ↗</a>}
          <a className="league-nav-cta" href="#enter">
            {session ? "Submit a jump" : "Join the league"}
          </a>
        </nav>
      </header>
      <main>
        <section className="league-hero">
          <div className="league-hero-copy">
            <p className="league-eyebrow">
              <span /> AUSTRALIA · PERFORMANCE · COMMUNITY
            </p>
            <h1>
              Different skies.
              <br />
              One <em>starting line.</em>
            </h1>
            <p className="league-intro">
              Your local drop zone. A nationwide challenge. Fly your round,
              upload your track and see how you measure up across Australia.
            </p>
            <div className="league-actions">
              <a className="league-button" href="#enter">
                Enter a round <span>↗</span>
              </a>
              <a className="league-text-link" href="#standings">
                Explore the standings ↓
              </a>
            </div>
            <div className="league-hero-facts">
              <span>
                <strong>03</strong> performance disciplines
              </span>
              <span>
                <strong>01</strong> national community
              </span>
            </div>
          </div>
          <div className="league-flight-art" aria-hidden="true">
            <span className="league-art-label">AUSTRALIA / OPEN SKIES</span>
            <svg viewBox="0 0 600 620">
              <defs>
                <linearGradient id="leagueSky" x2="0" y2="1">
                  <stop stopColor="#294d44" />
                  <stop offset="1" stopColor="#102825" />
                </linearGradient>
              </defs>
              <rect width="600" height="620" fill="url(#leagueSky)" />
              <g fill="none" stroke="#a7c9a4" opacity=".13">
                {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                  <path
                    key={i}
                    d={`M-100 ${120 + i * 70} Q180 ${-40 + i * 52} 340 ${190 + i * 36} T720 ${200 + i * 64}`}
                  />
                ))}
              </g>
              <path
                d="M105 330 L155 270 177 192 241 171 277 192 309 157 355 147 369 100 408 154 426 217 482 264 478 319 448 374 398 416 350 413 314 375 267 378 231 411 171 404 140 373 Z"
                fill="#b8cfab"
                fillOpacity=".08"
                stroke="#b8cfab"
                strokeOpacity=".4"
              />
              <path
                d="M382 448 L408 450 399 480 386 469Z"
                fill="#b8cfab"
                fillOpacity=".18"
              />
              <g fill="none" stroke="#d9f28c" strokeWidth="2">
                <path d="M180 331 Q240 130 401 268" strokeDasharray="5 7" />
                <path d="M401 268 Q450 345 334 391" strokeDasharray="5 7" />
              </g>
              {[
                [180, 331],
                [401, 268],
                [334, 391],
              ].map(([x, y]) => (
                <g key={x}>
                  <circle
                    cx={x}
                    cy={y}
                    r="15"
                    fill="#d9f28c"
                    fillOpacity=".12"
                  />
                  <circle cx={x} cy={y} r="4" fill="#d9f28c" />
                </g>
              ))}
              <path
                d="M287 237 l-27 20 31-5 23 26-7-31 19-24-30 12-11-24z"
                fill="#eff4dd"
                transform="rotate(-8 290 240)"
              />
            </svg>
            <div className="league-art-bottom">
              <span>
                FLY LOCAL.
                <br />
                <b>COMPETE NATIONWIDE.</b>
              </span>
              <span>
                2500 → 1500
                <br />
                METRES AGL
              </span>
            </div>
          </div>
        </section>
        <section className="league-round-strip">
          <span className="league-tag">PILOT LEAGUE</span>
          <div>
            <h2>{round?.title ?? "The first round starts here."}</h2>
            <p>
              {round
                ? `${date(round.opens_at)} — ${date(round.closes_at)} · ${accepting ? "Entries open" : round.published ? "Outside submission window" : "Draft · not open for entries"}`
                : "Monthly rounds. All states. Your next performance goal."}
            </p>
          </div>
          {rounds.length > 0 && (
            <label className="league-round-picker">
              Select round
              <select
                aria-label="Select round"
                disabled={busy}
                value={roundId}
                onChange={(e) => setRoundId(e.target.value)}
              >
                {rounds.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                    {!r.published ? " (draft)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
        </section>
        <section className="league-section" id="how">
          <div className="league-section-heading">
            <p className="league-eyebrow">A REASON TO FLY. A WAY TO IMPROVE.</p>
            <h2>
              Three disciplines.
              <br />
              Every jump counts.
            </h2>
          </div>
          <div className="league-task-grid">
            {[
              {
                name: "Speed",
                number: "01",
                unit: "km/h",
                text: "Find your pace. Ranked on wind-adjusted horizontal speed through the performance window.",
              },
              {
                name: "Time",
                number: "02",
                unit: "seconds",
                text: "Make the window last. Ranked on measured elapsed time, with corrected speed and distance shown alongside.",
              },
              {
                name: "Distance",
                number: "03",
                unit: "metres",
                text: "Make every metre work. Ranked on wind-adjusted horizontal displacement through the window.",
              },
            ].map((task) => (
              <article key={task.name} className="league-task">
                <span>
                  {task.number} / {task.unit}
                </span>
                <h3>
                  {task.name}
                  <span>↗</span>
                </h3>
                <p>{task.text}</p>
              </article>
            ))}
          </div>
          <p className="league-method-note">
            A consistent 2,500–1,500 m AGL window. GFS Global archived winds.
            Every result reviewed before publication.{" "}
            <a href="#rules">Read the pilot scoring method ↓</a>
          </p>
        </section>
        <section className="league-section league-standings" id="standings">
          <div className="league-section-top">
            <div>
              <p className="league-eyebrow">THE NATIONAL PICTURE</p>
              <h2>Round standings</h2>
            </div>
            <button
              className="league-secondary"
              disabled={busy || !roundId}
              onClick={() => void refresh()}
            >
              Refresh results ↻
            </button>
          </div>
          <div
            className="league-tabs"
            role="tablist"
            aria-label="Leaderboard discipline"
          >
            {["overall", ...disciplines].map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                className={tab === t ? "active" : ""}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          {results.length === 0 ? (
            <div className="league-empty">
              <span>↗</span>
              <h3>
                A fresh leaderboard.
                <br />
                Room for your name.
              </h3>
              <p>
                Approved results will appear here once the round gets underway.
              </p>
            </div>
          ) : (
            <div className="league-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Competitor</th>
                    <th>State</th>
                    {tab === "overall" ? (
                      <>
                        <th>Tasks</th>
                        <th>Round points</th>
                      </>
                    ) : (
                      <>
                        <th>Time / s</th>
                        <th>Corrected / km/h</th>
                        <th>Corrected / m</th>
                        <th>Ground / km/h</th>
                        <th>Ground / m</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {tab === "overall"
                    ? overall.map(([key, r]) => (
                        <tr key={key}>
                          <td>
                            {overall.findIndex(
                              ([, row]) =>
                                Math.abs(row.points - r.points) < 0.000001,
                            ) + 1}
                          </td>
                          <th>{r.name}</th>
                          <td>{r.region}</td>
                          <td>{r.tasks}/3</td>
                          <td>{fmt(r.points)}</td>
                        </tr>
                      ))
                    : ranked.map((r) => (
                        <tr key={r.competitor_key}>
                          <td>
                            {ranked.findIndex(
                              (row) =>
                                Math.abs(score(row, tab) - score(r, tab)) <
                                0.000001,
                            ) + 1}
                          </td>
                          <th>{r.public_name}</th>
                          <td>{r.region}</td>
                          <td>{fmt(r.time_s, 2)}</td>
                          <td>{fmt(r.corrected_speed_kmh)}</td>
                          <td>{fmt(r.corrected_distance_m)}</td>
                          <td>{fmt(r.raw_speed_kmh)}</td>
                          <td>{fmt(r.raw_distance_m)}</td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="league-caption">
            Best approved entry per discipline. Each task awards up to 1,000
            points relative to the round leader; overall is the sum of all
            three. Missing tasks score zero. Equal scores share rank.
          </p>
        </section>
        <section className="league-section league-entry-section" id="enter">
          <div>
            <p className="league-eyebrow">YOUR DROP ZONE. YOUR ROUND.</p>
            <h2>
              Bring your
              <br />
              <em>best flight.</em>
            </h2>
            <p>
              Submit an original FlySight CSV for speed, time or distance. You
              can enter up to 12 tracks per round. Your best approved result in
              each discipline counts.
            </p>
            <ol className="league-steps">
              <li>Sign in to your competitor account.</li>
              <li>Choose a discipline and upload your jump.</li>
              <li>Get reviewed. Get ranked. Keep improving.</li>
            </ol>
            <p className="league-caption">
              League entry is separate from access to the training app. Your
              original track stays private to you and the organiser.
            </p>
          </div>
          <div className="league-form-card">
            {!session ? (
              <>
                <h3>Your league starts here.</h3>
                <p>
                  Sign in or create your competitor account. League membership
                  does not grant training-app access.
                </p>
                {preview ? (
                  <p className="league-notice">
                    Choose Competitor or Organiser in the development toolbar
                    above to explore the signed-in screens.
                  </p>
                ) : (
                  <LeagueGoogleSignIn onStatus={setAuthStatus} />
                )}
                <p className="league-caption">
                  Use your Google account to join the pilot league.
                </p>
                {authStatus && <p role="status">{authStatus}</p>}
                {emailSignInEnabled && !preview && (
                  <>
                    <p className="league-caption">Or continue by email</p>
                    <form onSubmit={signIn}>
                      <label>
                        Email address
                        <input
                          type="email"
                          autoComplete="email"
                          required
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                        />
                      </label>
                      <button className="league-button" disabled={busy}>
                        Email me a sign-in link ↗
                      </button>
                    </form>
                    {authStatus && <p role="status">{authStatus}</p>}
                    <details>
                      <summary>Have an email code?</summary>
                      <label>
                        One-time code
                        <input
                          inputMode="numeric"
                          value={otp}
                          onChange={(e) => setOtp(e.target.value)}
                        />
                      </label>
                      <button
                        className="league-secondary"
                        disabled={busy || !otp || !email}
                        onClick={() => void verifyCode()}
                      >
                        Verify code
                      </button>
                    </details>
                  </>
                )}
              </>
            ) : (
              <>
                <div className="league-signed-in">
                  <span>Signed in as {session.user.email}</span>
                  <button
                    disabled={busy}
                    onClick={() => void client.auth.signOut()}
                  >
                    Sign out
                  </button>
                </div>
                <h3>Submit for {round?.title ?? "the next round"}</h3>
                {round && (
                  <p className="league-caption">
                    Deadline:{" "}
                    {new Intl.DateTimeFormat("en-AU", {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: "Australia/Sydney",
                    }).format(new Date(round.closes_at))}{" "}
                    (Sydney time).
                  </p>
                )}
                {!accepting && (
                  <p className="league-notice">
                    {round
                      ? "This round is not currently accepting entries."
                      : "The organiser has not opened a round yet."}
                  </p>
                )}
                <form ref={formRef} onSubmit={submit}>
                  <fieldset disabled={busy || !accepting}>
                    <div className="league-fields">
                      <label>
                        Public competitor name
                        <input
                          name="name"
                          required
                          minLength={2}
                          maxLength={60}
                          autoComplete="name"
                        />
                      </label>
                      <label>
                        Home state
                        <select
                          name="region"
                          required
                          value={homeState}
                          onChange={(event) => {
                            const selected = event.target.value;
                            setHomeState(selected);
                            try {
                              window.localStorage.setItem(
                                HOME_STATE_STORAGE_KEY,
                                selected,
                              );
                            } catch {
                              // Keep the selection usable when storage is unavailable.
                            }
                          }}
                        >
                          <option value="" disabled>
                            Select home state
                          </option>
                          {regions.map((r) => (
                            <option key={r}>{r}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Discipline
                        <select
                          name="discipline"
                          value={selectedTask}
                          onChange={(event) =>
                            setSelectedTask(event.target.value as Discipline)
                          }
                        >
                          {disciplines.map((d) => (
                            <option key={d}>{d}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Drop zone / location
                        <select name="location" required defaultValue="">
                          <option value="" disabled>
                            Select drop zone
                          </option>
                          {dropZones.map((dropZone) => (
                            <option key={dropZone} value={dropZone}>
                              {dropZone}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label>
                      Drop zone elevation / metres above sea level
                      <input
                        name="ground"
                        type="number"
                        required
                        min={-100}
                        max={3000}
                        step="0.1"
                        value={groundElevation}
                        onChange={(event) =>
                          setGroundElevation(event.target.value)
                        }
                      />
                      <small>
                        Use the verified drop zone elevation, not exit altitude.
                      </small>
                    </label>
                    <label className="league-file">
                      Original FlySight CSV
                      <input
                        name="track"
                        type="file"
                        accept=".csv,text/csv,text/plain"
                        required
                        onChange={(event) =>
                          setUploadFile(event.target.files?.[0] ?? null)
                        }
                      />
                      <small>
                        FlySight 1 or 2 · up to 8 MB · jump within the round
                        dates
                      </small>
                    </label>
                    <div aria-live="polite">
                      {calculatingUpload && (
                        <p className="league-caption">
                          Calculating your task score…
                        </p>
                      )}
                      {uploadScoreStatus && (
                        <p className="league-notice">{uploadScoreStatus}</p>
                      )}
                      {displayedUploadMetrics &&
                        displayedUploadValue != null && (
                          <section
                            className="league-upload-score"
                            aria-label="Calculated task score"
                          >
                            <p className="league-caption">
                              {uploadFile?.name ??
                                `Last uploaded track: ${lastSubmission?.filename}`}
                            </p>
                            <h4>Calculated {displayedUploadTask} score</h4>
                            <strong>
                              {fmt(
                                displayedUploadValue,
                                displayedUploadTask === "time" ? 2 : 1,
                              )}{" "}
                              <span>
                                {displayedUploadTask === "speed"
                                  ? "km/h"
                                  : displayedUploadTask === "time"
                                    ? "seconds"
                                    : "metres"}
                              </span>
                            </strong>
                            <p className="league-caption">
                              {displayedUploadTask === "time"
                                ? "Measured elapsed time through the 2,500–1,500 m AGL window. Pending organiser approval."
                                : "Provisional ground score through the 2,500–1,500 m AGL window. The wind-corrected competition result is calculated during organiser review."}
                            </p>
                          </section>
                        )}
                    </div>
                    <label className="league-checkbox">
                      <input name="coaching" type="checkbox" /> I’d like remote
                      coaching on this entry.
                    </label>
                    <label className="league-checkbox">
                      <input type="checkbox" required /> {preview
                        ? "Allow this local test to use the track’s location and time for archived wind lookup via Open-Meteo. This does not create an official competition entry."
                        : "I agree to the pilot rules below and to publishing my name, state and approved scores. My track may be reviewed by the organiser; its location and time are used to obtain weather data from Open-Meteo."}
                    </label>
                    <button
                      className="league-button"
                      disabled={busy || !accepting}
                    >
                      {busy ? "Working…" : "Submit for review ↗"}
                    </button>
                  </fieldset>
                </form>
              </>
            )}
          </div>
        </section>
        {session && entries.length > 0 && (
          <section className="league-section">
            <p className="league-eyebrow">
              {owner ? "ORGANISER WORKSPACE" : "YOUR PROGRESS"}
            </p>
            <h2>{owner ? "Review desk" : "Your entries"}</h2>
            <div className="league-entry-list">
              {entries.map((entry) => (
                <article key={entry.id} className="league-review-card">
                  <div className="league-section-top">
                    <h3>
                      {entry.public_name} <span>/ {entry.discipline}</span>
                    </h3>
                    <span className={`league-badge ${entry.status}`}>
                      {entry.status}
                    </span>
                  </div>
                  <p>
                    {entry.location_name} · {entry.region} ·{" "}
                    {date(entry.submitted_at)}
                    {entry.coaching_requested ? " · Coaching requested" : ""}
                  </p>
                  <div className="league-score-line">
                    <span>
                      Time <b>{fmt(entry.time_s, 2)} s</b>
                    </span>
                    <span>
                      Corrected speed{" "}
                      <b>{fmt(entry.corrected_speed_kmh)} km/h</b>
                    </span>
                    <span>
                      Corrected distance{" "}
                      <b>{fmt(entry.corrected_distance_m)} m</b>
                    </span>
                  </div>
                  {entry.scoring_version && (
                    <>
                      <p className="league-caption">
                        Ground speed: {fmt(entry.raw_speed_kmh)} km/h · Ground
                        distance: {fmt(entry.raw_distance_m)} m
                      </p>
                      {entry.jump_at && (
                        <p className="league-caption">
                          Recorded jump:{" "}
                          {new Date(entry.jump_at).toLocaleString("en-AU")}
                        </p>
                      )}
                      {entry.wind_snapshot && (
                        <p className="league-caption">
                          Wind model:{" "}
                          {entry.wind_snapshot.model === "gfs_global"
                            ? "GFS Global"
                            : entry.wind_snapshot.model}{" "}
                          · Archived winds retrieved{" "}
                          {new Date(
                            entry.wind_snapshot.fetched_at,
                          ).toLocaleString("en-AU")}
                        </p>
                      )}
                      {entry.file_hash && (
                        <p className="league-caption">
                          Original file SHA-256: {entry.file_hash.slice(0, 16)}…
                        </p>
                      )}
                      {entry.round_eligible === false && (
                        <p className="league-notice">
                          This jump is outside the round’s eligible dates and
                          cannot be approved.
                        </p>
                      )}
                    </>
                  )}
                  {entry.review_note && (
                    <p>
                      <b>Review:</b> {entry.review_note}
                    </p>
                  )}
                  {entry.coaching_note && (
                    <p className="league-feedback">
                      <b>Coaching feedback</b>
                      <br />
                      {entry.coaching_note}
                    </p>
                  )}
                  {owner && (
                    <>
                      <p className="league-caption">
                        Elevation: {entry.ground_elevation_m} m MSL ·{" "}
                        {entry.scoring_version ?? "Not calculated"}. Verify the
                        original file, location, elevation and discipline before
                        approval.
                      </p>
                      <div className="league-review-actions">
                        <button
                          disabled={busy || entry.status !== "pending"}
                          onClick={() =>
                            void act(
                              async () =>
                                await client.functions.invoke("league-score", {
                                  body: { entry_id: entry.id },
                                }),
                              "Scores calculated from the original file and archived winds.",
                              "Reading the original track and fetching archived GFS winds…",
                            )
                          }
                        >
                          Calculate wind-corrected scores
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              const response = await client.storage
                                .from("league-tracks")
                                .download(entry.file_path);
                              if (response.error) return response;
                              const url = URL.createObjectURL(response.data);
                              const a = document.createElement("a");
                              a.href = url;
                              a.download = `league-${entry.id}.csv`;
                              a.click();
                              setTimeout(() => URL.revokeObjectURL(url), 1000);
                              return { error: null };
                            }, "Original downloaded for review.")
                          }
                        >
                          Download original
                        </button>
                      </div>
                      <label>
                        Review note
                        <textarea
                          maxLength={2000}
                          value={note[entry.id] ?? ""}
                          onChange={(e) =>
                            setNote({ ...note, [entry.id]: e.target.value })
                          }
                        />
                      </label>
                      <div className="league-review-actions">
                        <button
                          disabled={busy || !entry.scoring_version}
                          onClick={() =>
                            void act(
                              async () =>
                                await client.rpc("league_review_entry", {
                                  entry_id: entry.id,
                                  decision: "approved",
                                  note: note[entry.id] ?? "",
                                }),
                              "Entry approved and leaderboard updated.",
                            )
                          }
                        >
                          Approve result
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(
                              async () =>
                                await client.rpc("league_review_entry", {
                                  entry_id: entry.id,
                                  decision: "rejected",
                                  note: note[entry.id] ?? "",
                                }),
                              "Entry rejected. The competitor can see your review note.",
                            )
                          }
                        >
                          Reject / withdraw
                        </button>
                      </div>
                      <label>
                        Private coaching feedback
                        <textarea
                          maxLength={6000}
                          value={
                            feedback[entry.id] ?? entry.coaching_note ?? ""
                          }
                          onChange={(e) =>
                            setFeedback({
                              ...feedback,
                              [entry.id]: e.target.value,
                            })
                          }
                        />
                      </label>
                      <button
                        className="league-secondary"
                        disabled={busy}
                        onClick={() =>
                          void act(
                            async () =>
                              await client.rpc("league_coaching_note", {
                                entry_id: entry.id,
                                note:
                                  feedback[entry.id] ??
                                  entry.coaching_note ??
                                  "",
                              }),
                            "Coaching feedback saved for the competitor.",
                          )
                        }
                      >
                        Save feedback
                      </button>
                    </>
                  )}
                </article>
              ))}
            </div>
            <p className="league-caption">
              Showing {entries.length} entries for this round.
            </p>
            {owner && entries.length >= entryLimit && (
              <button
                className="league-secondary"
                disabled={busy}
                onClick={() => setEntryLimit((current) => current + 200)}
              >
                Load more entries
              </button>
            )}
          </section>
        )}
        {owner && (
          <section className="league-section league-admin">
            <h2>Round control</h2>
            <p>
              Draft the dates in your device’s local timezone. Publishing locks
              the dates; submission deadlines are enforced by the server.
            </p>
            <form onSubmit={createRound}>
              <label>
                Round title
                <input
                  name="title"
                  minLength={3}
                  maxLength={100}
                  placeholder="Round 1 · December"
                  required
                />
              </label>
              <div className="league-fields">
                <label>
                  Opens
                  <input name="opens" type="datetime-local" required />
                </label>
                <label>
                  Closes
                  <input name="closes" type="datetime-local" required />
                </label>
              </div>
              <button disabled={busy} className="league-secondary">
                Create draft round
              </button>
            </form>
            {round && !round.published && (
              <button
                className="league-button"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `Open ${round.title} for its scheduled dates? Publishing locks the dates.`,
                    )
                  )
                    void act(async () => {
                      const response = await client
                        .from("league_rounds")
                        .update({ published: true })
                        .eq("id", round.id);
                      if (!response.error)
                        setRounds((current) =>
                          current.map((r) =>
                            r.id === round.id ? { ...r, published: true } : r,
                          ),
                        );
                      return response;
                    }, "Round published. Dates are now locked.");
                }}
              >
                Publish selected round ↗
              </button>
            )}
          </section>
        )}
        <section className="league-coaching" id="coaching">
          <div>
            <p className="league-eyebrow">MORE THAN A PLACE ON THE BOARD</p>
            <h2>
              Turn a result
              <br />
              into a <em>next step.</em>
            </h2>
          </div>
          <div>
            <p>
              Get a second set of eyes on your flight. Request remote coaching
              with your entry for individual feedback from Chris Geiler on your
              performance, flight profile and next training focus.
            </p>
            <p className="league-caption">
              Coaching is optional and arranged separately. Requesting it does
              not purchase a session or affect judging. Feedback is private
              between you and the organiser.
            </p>
            <a className="league-button" href="#enter">
              Request coaching with an entry ↗
            </a>
          </div>
        </section>
        <section className="league-section league-rules" id="rules">
          <p className="league-eyebrow">TRANSPARENT BY DESIGN</p>
          <h2>Pilot league rules</h2>
          <div className="league-rules-grid">
            <div>
              <h3>A fairer comparison</h3>
              <p>
                Speed and distance use the displacement between the interpolated
                2,500 m and 1,500 m AGL boundaries, less the integrated
                horizontal wind vector. Speed is corrected distance divided by
                elapsed time. Time rankings use measured elapsed time.
              </p>
              <p>
                All entries use GFS Global archived forecasts from Open-Meteo,
                interpolated in height and time. Forecast winds are estimates;
                correction does not guarantee identical atmospheric conditions
                between jumps. No silent substitution of another model.
              </p>
            </div>
            <div>
              <h3>Reviewed, then ranked</h3>
              <p>
                Upload original Australian FlySight tracks from within the round
                dates. Scores are calculated on the server, then reviewed by the
                organiser. Missing winds, incomplete windows and poor GPS
                samples remain unapproved. Original tracks are not public.
              </p>
              <p>
                This is an independent pilot league, not an official
                championship result. The method is versioned as pilot-v1. Best
                approved entry per discipline counts; future rule changes apply
                to future rounds. Queries and corrections go through the
                organiser.
              </p>
            </div>
          </div>
        </section>
      </main>
      {status && (
        <div className="league-toast" role="status">
          <span>{status}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setStatus("")}
          >
            ×
          </button>
        </div>
      )}
      <footer className="league-footer">
        <b>AUSTRALIAN WINGSUIT LEAGUE</b>
        <span>Fly local. Compete nationwide.</span>
        <a href="#rules">Scoring & privacy</a>
      </footer>
    </div>
  );
}
