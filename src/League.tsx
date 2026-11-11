import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { leagueWindow, fetchLeagueWinds, scoreLeagueWindow } from "./leagueScoring";
import { fetchLocalLeagueWinds } from "./leagueLocalWeather";
import LeagueGoogleSignIn from "./LeagueGoogleSignIn";
import LeagueRegistration from "./LeagueRegistration";
import LeagueEntryEditor from "./LeagueEntryEditor";
import LeagueScoreboard from "./LeagueScoreboard";
import LeagueAppPromo from "./LeagueAppPromo";
import type { LeagueScoreboardEntry } from "./leagueScoreboardModel";
import { dropZoneReferences } from "./leagueDropZones";
import type { RegistrationAccess } from "./LeagueRegistration";
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
  wind_snapshot?: { model: string; fetched_at: string; provider?: string; fallback_reason?: string } | null;
  round_eligible?: boolean;
  revision?: number;
};
const emailSignInEnabled =
  import.meta.env.VITE_LEAGUE_EMAIL_SIGN_IN_ENABLED === "true";
const regions = ["ACT", "NSW", "NT", "QLD", "SA", "VIC", "WA"];
const HOME_STATE_STORAGE_KEY = "ntf-league-home-state";
const dropZones = dropZoneReferences.map((reference) => reference.name);
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
const reviewKey = (entry: { id: string; revision?: number }) => `${entry.id}:${entry.revision ?? 0}`;
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
  const [results, setResults] = useState<LeagueScoreboardEntry[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [editingEntry, setEditingEntry] = useState<string | null>(null);
  const [entryLimit, setEntryLimit] = useState(200);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [registrationAccess, setRegistrationAccess] =
    useState<RegistrationAccess>("checking");
  const [selectedTask, setSelectedTask] = useState<Discipline>("speed");
  const [groundElevation, setGroundElevation] = useState("");
  const [selectedDropZone, setSelectedDropZone] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadMetrics, setUploadMetrics] = useState<UploadMetrics | null>(
    null,
  );
  const [uploadScoreStatus, setUploadScoreStatus] = useState("");
  const [calculatingUpload, setCalculatingUpload] = useState(false);
  const [correctedUpload, setCorrectedUpload] = useState<{
    file: File;
    ground: string;
    metrics: UploadMetrics;
    provider?: string;
  } | null>(null);
  const [windScoreStatus, setWindScoreStatus] = useState("");
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
  const reviewAttempts = useRef(new Set<string>());
  const [reviewScores, setReviewScores] = useState<Record<string, string>>({});
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
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setCorrectedUpload(null);
    setWindScoreStatus("");
    if (!uploadFile || !groundElevation.trim()) return;
    const timer = setTimeout(() => {
      setWindScoreStatus("Calculating from archived winds…");
      void (async () => {
        try {
          const points = leagueWindow(await uploadFile.text(), Number(groundElevation));
          measureLeagueUploadWindow(points);
          if (cancelled) return;
          const winds = await (preview ? fetchLocalLeagueWinds : fetchLeagueWinds)(points, (input, init) => fetch(input, {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([init.signal, controller.signal])
              : controller.signal,
          }));
          const scores = scoreLeagueWindow(points, winds);
          if (cancelled) return;
          setCorrectedUpload({ file: uploadFile, ground: groundElevation, provider: winds.provider ?? "open-meteo", metrics: {
            timeSeconds: scores.time_s,
            speedKmh: scores.corrected_speed_kmh,
            distanceMetres: scores.corrected_distance_m,
          } });
          setWindScoreStatus("");
        } catch (error) {
          if (!cancelled) setWindScoreStatus(error instanceof Error
            ? `Wind correction unavailable: ${error.message}`
            : "Wind correction unavailable. Try again.");
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [uploadFile, groundElevation, preview]);
  const currentCorrectedMetrics = correctedUpload?.file === uploadFile &&
    correctedUpload?.ground === groundElevation
    ? correctedUpload.metrics : undefined;
  const displayedCorrectedMetrics = uploadFile ? currentCorrectedMetrics : undefined;
  const displayedUploadMetrics = uploadFile ? uploadMetrics : null;
  const displayedUploadTask = selectedTask;
  const displayedUploadValue =
    displayedUploadMetrics &&
    (displayedUploadTask === "speed"
      ? displayedUploadMetrics.speedKmh
      : displayedUploadTask === "time"
        ? displayedUploadMetrics.timeSeconds
        : displayedUploadMetrics.distanceMetres);
  const displayedCorrectedValue = displayedCorrectedMetrics &&
    (displayedUploadTask === "speed" ? displayedCorrectedMetrics.speedKmh
      : displayedUploadTask === "time" ? displayedCorrectedMetrics.timeSeconds
        : displayedCorrectedMetrics.distanceMetres);
  useEffect(() => {
    setEntryLimit(200);
    setResults([]);
  }, [roundId]);
  const round = rounds.find((r) => r.id === roundId);
  const accepting =
    !!round?.published &&
    Date.now() >= Date.parse(round.opens_at) &&
    Date.now() < Date.parse(round.closes_at);
  const canEnter = owner || registrationAccess === "approved";
  function rememberHomeState(selected: string) {
    setHomeState(selected);
    try {
      window.localStorage.setItem(HOME_STATE_STORAGE_KEY, selected);
    } catch {
      /* Browser preference is optional. */
    }
  }

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
    const { data, error } = await client.rpc("league_round_scoreboard", {
      selected_round: roundId,
    });
    if (currentEpoch !== epoch.current || requestId !== refreshId.current)
      return;
    if (error) {
      setStatus(error.message);
      return;
    }
    setResults((data ?? []) as LeagueScoreboardEntry[]);
    if (session) {
      let query = client
        .from("league_entries")
        .select(
          "id,round_id,public_name,region,discipline,status,location_name,ground_elevation_m,file_path,submitted_at,coaching_requested,coaching_note,review_note,time_s,corrected_speed_kmh,corrected_distance_m,raw_speed_kmh,raw_distance_m,scoring_version,jump_at,file_hash,wind_snapshot,revision",
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

  useEffect(() => {
    if (!owner) return;
    const entry = entries.find((row) => row.status === "pending" &&
      !row.scoring_version && !reviewAttempts.current.has(`${row.id}:${row.revision ?? 0}`));
    if (!entry) return;
    reviewAttempts.current.add(`${entry.id}:${entry.revision ?? 0}`);
    const currentEpoch = epoch.current;
    setReviewScores((current) => ({ ...current, [reviewKey(entry)]: "Calculating scores from the original track and archived winds…" }));
    void (async () => {
      try {
        const response = await client.functions.invoke("league-score", { body: { entry_id: entry.id } });
        if (currentEpoch !== epoch.current) return;
        setReviewScores((current) => ({ ...current, [reviewKey(entry)]: response.error
          ? `Calculation failed: ${response.error.message}` : "" }));
      } catch (error) {
        if (currentEpoch !== epoch.current) return;
        setReviewScores((current) => ({ ...current, [reviewKey(entry)]: `Calculation failed: ${error instanceof Error ? error.message : "Please retry."}` }));
      }
      if (currentEpoch === epoch.current) await refresh();
    })();
  }, [entries, owner, client, refresh]);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setAuthStatus("");
    const { error } = await client.auth.signInWithOtp({
      email: email.trim(),
      options: {
        shouldCreateUser: true,
        emailRedirectTo: new URL("/ozleague/", window.location.origin).href,
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
    if (!canEnter) {
      setStatus(
        "Your league registration must be approved before entering a round.",
      );
      return;
    }
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
      formRef.current?.reset();
      setUploadFile(null);
      setUploadMetrics(null);
      setCorrectedUpload(null);
      setUploadScoreStatus("");
      setWindScoreStatus("");
      setCalculatingUpload(false);
      setGroundElevation("");
      setSelectedDropZone("");
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

  return (
    <div className="league">
      <header className="league-header">
        <a
          className="league-brand"
          href="/ozleague/"
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
          <a
            className="league-nav-cta"
            href={session && !canEnter ? "#registration" : "#enter"}
          >
            {session && canEnter ? "Submit a jump" : "Register to enter"}
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
              <em>One window of flight.</em>
            </h1>
            <p className="league-intro">
              Your local drop zone. A nationwide challenge.
              <br />
              Fly when you can, upload your track and see how you measure up across Australia.
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
                <strong>03</strong> performance tasks
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
              Three tasks.
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
                text: "Fly fast! Ranked on wind-adjusted horizontal speed through the performance window.",
              },
              {
                name: "Time",
                number: "02",
                unit: "seconds",
                text: "Fly slow! Ranked on measured elapsed time, with corrected speed and distance shown alongside.",
              },
              {
                name: "Distance",
                number: "03",
                unit: "metres",
                text: "Make every metre count. Ranked on wind-adjusted horizontal distance through the performance window.",
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
        <section className="league-section" id="standings">
          <LeagueScoreboard key={roundId} client={client} rows={results}
            roundTitle={round?.title ?? "Select a round"} onRefresh={() => void refresh()} />
        </section>
        <LeagueAppPromo appAccess={appAccess} />
        {session && (
          <LeagueRegistration
            client={client}
            userId={session.user.id}
            owner={owner}
            regions={regions}
            homeState={homeState}
            onHomeStateChange={rememberHomeState}
            onAccessChange={setRegistrationAccess}
            preview={preview}
          />
        )}
        <section className="league-section league-entry-section" id="enter">
          <div>
            <p className="league-eyebrow">YOUR DROP ZONE. YOUR ROUND.</p>
            <h2>
              Bring your
              <br />
              <em>best flight.</em>
            </h2>
            <p>
              Submit an original FlySight CSV file for speed, time or distance. You
              can enter up to 12 tracks per round. Your best approved result in
              each task counts. You'll need to submit a minimum of 1 track per task to complete the round.
            </p>
            <ol className="league-steps">
              <li>Sign in to your competitor account.</li>
              <li>Choose a task and upload your jump.</li>
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
                {canEnter ? (
                  <form ref={formRef} onSubmit={submit}>
                    <fieldset disabled={busy || !accepting}>
                      <div className="league-fields">
                        <label>
                          Public competitor name
                          <input
                            name="name"
                            defaultValue={preview ? session.user.user_metadata?.full_name ?? "" : ""}
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
                            onChange={(event) =>
                              rememberHomeState(event.target.value)
                            }
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
                          Task
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
                          <select name="location" required value={selectedDropZone}
                            onChange={(event) => {
                              const location = event.target.value;
                              const reference = dropZoneReferences.find((dz) => dz.name === location);
                              setSelectedDropZone(location);
                              setGroundElevation(reference?.metres == null ? "" : String(reference.metres));
                            }}>
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
                          Filled from Skyderby when available. You can adjust it for
                          the actual landing area. Unlisted elevations must be entered manually.
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
                                {uploadFile?.name}
                              </p>
                              <h4>Raw {displayedUploadTask} score</h4>
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
                              <h4>Wind-corrected {displayedUploadTask} score</h4>
                              {displayedCorrectedValue != null ? <strong>
                                {fmt(displayedCorrectedValue, displayedUploadTask === "time" ? 2 : 1)}{" "}
                                <span>{displayedUploadTask === "speed" ? "km/h" : displayedUploadTask === "time" ? "seconds" : "metres"}</span>
                              </strong> : <p className="league-caption">
                                {windScoreStatus || "Calculating wind-corrected score…"}
                              </p>}
                              <p className="league-caption">
                                {displayedCorrectedMetrics && <>Weather: {correctedUpload?.provider === "meteomatics" ? "Meteomatics" : "Open-Meteo"} · GFS Global. </>}
                                {displayedUploadTask === "time" ? "Time is unchanged by horizontal wind correction. " : ""}
                                Provisional scores through the 2,500–1,500 m AGL window. Pending organiser approval.
                              </p>
                            </section>
                          )}
                      </div>
                      <label className="league-checkbox">
                        <input name="coaching" type="checkbox" /> I’d like
                        remote coaching on this entry.
                      </label>
                      <p className="league-caption">
                        Track location and time are required for automatic wind correction using Open-Meteo, or Meteomatics when configured.
                        {!preview && " Submitting an entry accepts the pilot rules and publication of your name, state, approved scores and relative replay. Original GPS files stay private to you and the organiser."}
                      </p>
                      <button
                        className="league-button"
                        disabled={busy || !accepting}
                      >
                        {busy ? "Working…" : "Submit for review ↗"}
                      </button>
                    </fieldset>
                  </form>
                ) : (
                  <p className="league-notice">
                    {registrationAccess === "checking"
                      ? "Checking your league registration…"
                      : "Registration approval is required before you can upload round entries."}{" "}
                    <a href="#registration">View registration</a>
                  </p>
                )}
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
            {(owner ? [null] : disciplines).map((task) => {
              const taskEntries = task ? entries.filter(entry => entry.discipline === task) : entries;
              const Section = task ? "details" : "div";
              return (
              <Section key={task ?? "review"} className={task ? "league-task-section" : undefined}>
                {task && <summary>{task[0].toUpperCase() + task.slice(1)} ({taskEntries.length})</summary>}
                {task && taskEntries.length === 0 && <p className="league-caption">No {task} entries for this round.</p>}
                <div className="league-entry-list">
              {taskEntries.map((entry) => (
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
                  <p className="league-caption">
                    Raw speed: {fmt(entry.raw_speed_kmh)} km/h · Raw distance: {fmt(entry.raw_distance_m)} m
                  </p>
                  {reviewScores[reviewKey(entry)] && <p className="league-notice" role="status">{reviewScores[reviewKey(entry)]}</p>}
                  {entry.scoring_version && (
                    <>
                      {entry.jump_at && (
                        <p className="league-caption">
                          Recorded jump:{" "}
                          {new Date(entry.jump_at).toLocaleString("en-AU")}
                        </p>
                      )}
                      {entry.wind_snapshot && (
                        <p className="league-caption">
                          Weather source: {entry.wind_snapshot.provider === "meteomatics" ? "Meteomatics" : "Open-Meteo"} · Wind model:{" "}
                          {entry.wind_snapshot.model === "gfs_global"
                            ? "GFS Global"
                            : entry.wind_snapshot.model}{" "}
                          · Archived winds retrieved{" "}
                          {new Date(
                            entry.wind_snapshot.fetched_at,
                          ).toLocaleString("en-AU")}
                        </p>
                      )}
                      {entry.wind_snapshot?.fallback_reason && <p className="league-caption">Fallback used: {entry.wind_snapshot.fallback_reason}</p>}
                      {entry.file_hash && (
                        <p className="league-caption">
                          Original file SHA-256: {entry.file_hash.slice(0, 16)}…
                        </p>
                      )}
                      {entry.round_eligible === false && (
                        <p className="league-notice">
                          {preview
                            ? "This jump is outside the round’s dates. Allowed for local testing only."
                            : "This jump is outside the round’s eligible dates and cannot be approved."}
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
                  {!owner && entry.status === "pending" && accepting && canEnter && (
                    editingEntry === entry.id ? <LeagueEntryEditor key={`${entry.id}:${entry.revision ?? 0}`}
                      client={client} entry={entry} userId={session.user.id}
                      onCancel={() => setEditingEntry(null)} onSaved={async () => {
                        setEditingEntry(null); setStatus("Entry updated. Scores will be recalculated before organiser approval."); await refresh();
                      }} /> : <button className="league-secondary" onClick={() => setEditingEntry(entry.id)}>Edit submitted track</button>
                  )}
                  {owner && (
                    <>
                      <p className="league-caption">
                        Elevation: {entry.ground_elevation_m} m MSL ·{" "}
                        {entry.scoring_version ?? "Not calculated"}. Verify the
                        original file, location, elevation and task before
                        approval.
                      </p>
                      <div className="league-review-actions">
                        <button
                          disabled={busy || entry.status !== "pending" || reviewScores[reviewKey(entry)]?.startsWith("Calculating")}
                          onClick={() =>
                            void act(
                              async () => {
                                setReviewScores((current) => ({ ...current, [reviewKey(entry)]: "Calculating scores…" }));
                                const response = await client.functions.invoke("league-score", {
                                  body: { entry_id: entry.id },
                                });
                                setReviewScores((current) => ({ ...current, [reviewKey(entry)]: response.error ? `Calculation failed: ${response.error.message}` : "" }));
                                return response;
                              },
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
                                  expected_revision: entry.revision ?? 0,
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
                                  expected_revision: entry.revision ?? 0,
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
              </Section>
              );
            })}
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
              not purchase a session or affect judging.
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
                elapsed time. Time rankings use measured elapsed time with no
                factoring for winds on the final score.
              </p>
              <p>
                All entries use GFS Global archived forecasts from Open-Meteo,
                interpolated in height and time. Forecast winds are estimates;
                correction does not guarantee identical atmospheric conditions
                between jumps.
              </p>
            </div>
            <div>
              <h3>Reviewed, then ranked</h3>
              <p>
                Upload your FlySight tracks from within the round
                dates at an Australian DZ. Scores are calculated on the server, then reviewed by the
                organiser. Missing winds, incomplete windows and poor GPS
                samples remain unapproved. Original tracks are not public.
              </p>
              <p>
                This is an independent pilot league, not an official
                championship result. The method is versioned as pilot-v1. Best
                approved entry per task counts; future rule changes apply
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
