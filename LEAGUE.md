# Australian Wingsuit League — initial pilot

## Competition categories — released 13 November 2026

Beginner (suits smaller than an ATC/Strix), Intermediate (non-race/non-competition
suits), and Open (experienced competitors in race/competition suits) have separate
scoreboard tabs and independent task leaders/points, each with a 300-point maximum.
Competitors select a category for each track. The category appears on private entry
and organiser review cards. Pending edits may change category and invalidate the
old scoring/replay; approved entries cannot be edited. Attempt numbering is scoped
to category as well as competitor/task/round, including replay labels.

Existing entries default to Open without changing recorded scores. Old seven-field
edit clients preserve the existing category. The organiser authorised publication;
the database migration is applied. The regression checks in tests/leagueCategories.sql
passed against the live database with all fixtures rolled back. Local checks:
33 league tests, TypeScript and production build pass; category tab switching
verified in the browser.

## Release — 11 November 2026

Published route: `https://numbers.flywithcruza.com/ozleague/`.
The legacy `/league.html` route remains available. Registration approval,
scoreboard/replay and pending-entry editing migrations have now been applied
to the live project. The revision-aware `league-score` function is deployed
with JWT verification. Database access checks passed with all fixtures rolled
back. No local competitors, tracks, scores or test rounds were migrated.

Live rounds must be created and published by the organiser. Production scoring
enforces the GPS scoring window's timestamps against the selected round dates,
and rejects jumps after submission. The local development adapter alone permits
tracks from other months for testing. Local roles are excluded from builds.

The promotional screenshot tiles support full-size previews. Training-app
access remains separately approved. Meteomatics is not configured; production
uses Open-Meteo GFS. The optional weather fallback remains local infrastructure.

The development notes below describe the implementation history; references
to migrations being prepared/unapplied predate this release.

Independent entry point: `/ozleague/`. The existing app stays at `/` behind
its existing access controls. League sign-in never inserts into `app_access`.
Only authorised app users see the optional Numbers to Fly link on the league.
The working name, colours and copy are provisional.

## Local development testing

Keep this pilot unpublished until the organiser explicitly approves release.
Vite development on a loopback host opens a local test adapter with Visitor,
Competitor and Organiser views. There are no preloaded competitors or placeholder
scores. The initial local test round covers archived jumps from 2022 onwards;
it is not an official monthly round.

Uploads store the actual original CSV in this browser's IndexedDB. Entries,
results, retained winds and coaching feedback survive refresh on the same local
origin. Reset local test clears only this test data after confirmation. It does
not touch Supabase. Different hosts or ports use separate browser stores.

Calculate wind-corrected scores reads that original file, uses the same parser,
window and scoring functions as the server, and fetches real archived GFS Global
winds from Open-Meteo. No fixed or fabricated values are assigned. An organiser
upload calculates automatically; competitor uploads wait for organiser
calculation. Failures leave the entry pending. Cached calculations retain their
original weather snapshot and SHA-256. Approval updates only the local test
leaderboard. The wide test round permits historical tracks; user-created test
rounds can test eligibility restrictions.

Only the account/role selection and database transport remain local adapters.
This verifies genuine file/weather/calculation behaviour and local workflow; it
does not verify real Google login, Supabase RLS, the deployed Edge Function or
production storage HTTP uploads. The SQL role tests cover database permissions
separately. Complete an authenticated end-to-end run before opening a live round.

Try real sign-in switches back to the existing authenticated backend. The
observed local login blocker is Google's `origin not allowed` error. Add the
exact local origin to the Google OAuth client's Authorized JavaScript origins
before testing real local login. No Google settings or production authentication
permissions are changed by the local test adapter. The adapter and its local
accounts remain excluded from production builds.

## Competitor journey

Competitors must request league registration with their name and home state.
Only the organiser can approve, decline or revoke registration. Pending,
declined and revoked registrations cannot upload originals or submit entries.
Approval applies across rounds; each jump still requires separate score review.
Organisers retain their management access. Registration does not grant access
to the training app, and prior training-app access does not approve a competitor.
The registration queue and organiser notes are private. Local registrations
survive refresh alongside local tracks; previous saved tracks are retained.

The registration migration is prepared locally and has not been applied to the
live Supabase project. Apply it as part of an authorised release: it restricts
both Storage uploads and entry inserts, rather than relying on hidden controls.

Home state starts unselected and remembers the last chosen state in browser
storage. The selector excludes TAS. Drop zone uses the supplied club list, with
Moruya replacing Skydive Oz. Selecting a CSV and entering ground elevation shows
the calculated score for the nominated task: km/h, seconds or metres. Changing
the task changes the displayed score; changing elevation recalculates the
window. Speed and distance previews are provisional ground measurements, not
wind-corrected official results. No weather lookup occurs during file selection.

Sign in with Google using the existing production Google client. Choose an open
round, a discipline, public name, home state, drop zone and verified ground
elevation. Submit an original FlySight CSV (maximum 8 MB). The file is stored in
the private `league-tracks` bucket, not in the existing logbook database. The
upload policy caps files at 12 per competitor per round; competitors cannot
replace submitted originals. Failed submissions clean up their unused file.

Submitting an entry requires consent to public name/state/results and private
track review, including location/time use for archived weather lookup. Original
files, exact GPS coordinates, review notes and coaching are not public.

Google identity-token sign-in stays on the league page. Email sign-in is off by
default, so an unconfigured Supabase redirect cannot send competitors into the
training app. To enable email later, first allowlist the exact production
`https://numbers.flywithcruza.com/league.html` return URL in Supabase Auth, verify
the email link/code flow, then set `VITE_LEAGUE_EMAIL_SIGN_IN_ENABLED=true` in
the production build environment. The current workflow does not set this flag.

## Organiser workflow

Sign in with an existing app-owner account on the league page. Round control
creates draft rounds; set the desired month using local start/end timestamps.
Publish locks the round dates. No actual competition round is seeded by setup.

The review desk loads 200 entries at a time, with a Load more option. Download the original
to check its provenance, drop zone elevation and nominated discipline. Calculate
scores, then approve or reject with a note. Approval is a separate action; a
calculation never publishes automatically. Approved results can be withdrawn by
rejecting them. An unscored or ineligible entry cannot be approved.

The optional coaching request does not charge the competitor. The organiser can
leave private feedback on the entry; pricing, appointments, notifications and
payments are not part of this initial pilot.

## Pilot scoring v1

- Window: 2,500–1,500 m above the declared, organiser-verified ground elevation.
- Window boundaries interpolate GPS positions and actual UTC timestamps.
- Time: measured elapsed time; no wind adjustment.
- Ground distance: endpoint displacement using a local tangent-plane estimate.
- Wind correction: integrate the horizontal wind vector through the window and
  subtract it from the ground-displacement vector. Corrected speed is corrected
  distance divided by elapsed time, converted to km/h.
- Winds: fixed GFS Global archived forecast, Open-Meteo Historical Forecast API;
  interpolate wind components over height and UTC time. No fallback model, no
  zero-wind fallback for unavailable data.
- Save model, pressure-level wind values, lookup timestamp, algorithm version
  and original SHA-256 with the calculation. Scored entries do not silently
  refetch weather on later reviews.
- Reject incomplete windows, missing timestamps, non-increasing timestamps,
  gaps over 2 seconds, poor reported accuracy and positions outside the broad
  Australian geographic envelope. Organiser review still verifies locality and
  original authenticity; a GPS CSV is not cryptographic proof of a flight.
- Weather-model correction is an estimate, not complete atmospheric equivalence.
- Best approved score per competitor/discipline counts. Task points are
  `1000 × result / best result`; round overall sums three tasks. Missing tasks
  contribute zero. Ties share a rank. This is a pilot format, not a claim of
  compliance with an official championship scoring specification.

## Backend and deployment

Migration files create two RLS-protected league tables, a private bucket,
organiser-checked review/feedback RPCs and a narrowly projected public
leaderboard RPC. The upload-count helper lives in the unexposed `league_private`
schema to avoid recursive Storage policies. Public leaderboard access is
intentional; competitors cannot edit calculated values or approval fields.

Edge function: `league-score`, JWT verification enabled. It additionally checks
the authenticated user is an app owner before using a server-only service key.
Bundle the function with these source-relative files:

- `supabase/functions/league-score/index.ts` (entrypoint)
- `src/leagueScoring.ts`
- `src/gpsAnalysis.ts`

Vite builds both `index.html` and `league.html`; the existing GitHub Pages
workflow deploys both. No link to the league is added inside the training app.

## Verification

Run `npx tsc -b`, `npm run test:league`, existing project tests and `npm run build`.
`tests/leagueAccess.sql` tests real RLS/role boundaries and review transitions in
a transaction that rolls back every fixture. It verifies private upload,
cross-account isolation, public results projection and the absence of app access
for league-only accounts.

Desktop and mobile layouts were checked in the browser. Real Google sign-in and
a real competitor's full upload-to-approval journey must be tested with the
organiser before opening the first round. Automated role tests are not a claim
that an actual competitor has completed that journey.

## Before opening the first round

Confirm the league name, dates, scoring window, submission allowance and points
format with the organiser; validate corrected results against known tracks.
Choose a retained-file policy and check Supabase Storage as well as egress as
the season grows. At 0.87 MB per original, 50 competitors uploading 12 tracks
each is roughly 522 MB per round, before other files. The current free Storage
allowance is finite; multiple retained rounds may warrant a plan change.

Check Open-Meteo's current commercial-use terms before offering paid coaching
against this weather integration. The initial integration uses its public API;
it does not purchase a commercial licence or take payments.
# Drop zone elevation references

Pending entry editing: competitors can use Edit submitted track on their own
pending entries while the round is open and their registration remains approved.
They can change public name, state, discipline, DZ, elevation, coaching request,
or optionally replace the CSV. Cancel does not alter the saved entry. Replacement
uploads are immutable new objects; the previous object is cleaned up only after
the edit succeeds. At the 12-entry limit, one temporary replacement upload is
allowed without permitting a thirteenth entry.

The guarded league_edit_entry RPC accepts only editable fields, preserves entry
identity / owner / round, increments revision and clears all scores, wind data,
file hash and derived replay. It remains pending. Organiser review recalculates
each new revision. In-flight calculations and stale review decisions cannot
overwrite or approve a different revision. Approved / rejected / closed-round
entries are not editable by competitors. These rules are verified in local
adapter tests and the replacement-file browser workflow on port 5176.

Production preparation only: 20261111045931_add_pending_league_entry_edits.sql
and the revision-aware league-score source are not applied / deployed. Apply
pending migrations before releasing the updated UI and scorer together.

Local multi-competitor testing: choose View as Competitor, then Test competitor
1-4 in the development toolbar. Each profile has a distinct stable test user ID,
registration approval, uploads, entries and scoreboard row. Existing local data
remains with Competitor 1. Request registration for each new profile and approve
it in Organiser mode before submitting. The selected profile is remembered in
browser storage. No Google/Supabase account is created or signed in. Original
downloads and upload cleanup remain restricted to the active profile; the
organiser can review all competitors. Public names are filled from registration.

## Round scoreboard and replay

Each selected round has a scoreboard with grouped Distance, Speed and Time
attempts, per-attempt percentages, best task percentages and a round total.
The league uses the best approved attempt per discipline, up to 100
points each / 300 total; equal scores share rank. This differs from averaging
all championship jumps. Only approved entries from published rounds appear.

Up to four score cells can be selected for replay. Traces are requested only
after Replay selected is clicked. Replay uses the saved scoring wind snapshot,
interpolates actual GPS timestamps, removes the integrated horizontal wind
vector, aligns scoring-window entry at zero seconds / zero distance, and rotates
each flight onto its corrected overall flight direction. The displayed endpoint
matches the authoritative corrected displacement. Altitude remains AGL and time
is unchanged. Only the 2,500-1,500 m scored window is replayed.

Controls: play/pause, restart, continuous scrubber, 0.25-4x playback, corrected
distance / elapsed-time axis and zoom. Shorter tracks freeze at their own finish.
Public payloads contain relative seconds, AGL altitude, relative horizontal
geometry and corrected speed only. They exclude GPS coordinates, absolute times,
original files, weather-location payloads, email and private coaching notes.
Withdrawn / unapproved / draft-round entries cannot be replayed. The RPC enforces
one to four distinct entries from a single round; originals retain private access.

The local adapter implements these RPCs and can generate legacy approved replays
from saved winds on demand without another weather request. Newly scored entries
persist the derived replay. Synthetic four-track browser QA is isolated on port
5176; user data on port 5175 is not seeded or approved by these tests.

Production preparation only: migration
20261111015621_add_league_scoreboard_replay.sql adds replay_data and narrow public
league_round_scoreboard / league_replay_tracks RPCs, and league-score prepares the
derived payload on scoring. This migration and Edge Function change have NOT
been applied or deployed. Existing production scored entries would need an
organiser-controlled replay backfill from their original file and saved winds
before becoming replayable. No production originals are made public.

Local weather reliability: Vite serves a same-origin POST /api/league-winds
endpoint, used by both import preview and the local review scorer. It gives
Open-Meteo 45 seconds, shares identical in-flight lookups and retains up to 100
successful snapshots for one hour in server memory. Saved scored entries retain
their original snapshots; they are never silently recalculated.

An optional server-only Meteomatics fallback is prepared. It requires
METEOMATICS_USERNAME and METEOMATICS_PASSWORD in .env.local, with account access
to historical upper-air data. See .env.league-weather.example. No account is
currently configured or purchased. Do not prefix credentials with VITE_.
The fallback explicitly requests source=ncep-gfs to preserve the league's fixed
GFS model; it is not an assertion that a different model is more accurate.
Snapshots record provider, model, retrieval time and fallback reason. Failed or
incomplete winds still prevent approval. Meteomatics parsing/fallback is tested
with mocked responses; a live credentialed test remains outstanding.

This server-only fallback is local development infrastructure. It has not been
deployed to Supabase or published. A production preview needs an authenticated
server endpoint with secrets before enabling this fallback there.

The organiser review desk automatically calculates previously unscored pending
entries from their original files and archived winds, refreshing each result.
Failures are shown on the affected card and can be retried manually. The local
scorer persists raw time, speed and distance before the weather request, so a
weather failure does not hide valid raw measurements. Approval still requires
successful authoritative scoring with saved winds. Import previews alone never
make an entry approvable.

The jump-import score panel shows both raw and wind-corrected scores for the
selected task. Raw measurements remain local. Selecting a track with a valid
DZ elevation automatically retrieves archived GFS winds using the shared scoring
functions. Location/time lookup is required for entry; there is no opt-in checkbox.
Changing the original file or elevation invalidates the previous corrected
preview, cancels the old request and recalculates; changing task reuses the
calculated metrics. Unavailable winds show an error, never a zero-wind fallback.
These previews remain provisional until server calculation and organiser review.

The local league uses Skyderby MSL elevations for all 12 matched locations:
Lower Light 17 m, Commando 45 m, Tully 20 m, Hillman Farm 258 m, Elderslie 34 m,
Ramblers 94 m, Langhorne Creek 6 m, Byron Bay 7 m, Great Ocean Road 15 m,
Jurien Bay 3 m, Moruya 5 m, and Torquay 9 m. Each links to its place record.
Checked 11 November 2026. APF values are no longer used for the import reference.

Selecting a DZ fills its Skyderby elevation into the controlled scoring field,
which recalculates an already selected track and is submitted as ground_elevation_m.
Changing DZ replaces the previous value; selecting an unmatched DZ clears it so
an elevation from another location cannot carry across. Manual adjustment remains
available. Previous entries and their recorded elevations are unchanged.

Airlie Beach Skydivers, Coastal Skydive SA and Darwin Parachute Club were not
matched in Skyderby's Australian places list and require a manual confirmed value.
No runway, weather-station or town elevation is used as a substitute.
