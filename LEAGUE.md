# Australian Wingsuit League — initial pilot

Independent entry point: `/league.html`. The existing app stays at `/` behind
its existing access controls. League sign-in never inserts into `app_access`.
Only authorised app users see the optional Numbers to Fly link on the league.
The working name, colours and copy are provisional.

## Local development review

Keep this pilot unpublished until the organiser explicitly approves release.
Vite development on a loopback host opens a separate preview adapter with a
sticky Visitor / Competitor / Organiser selector. It starts in Organiser view
so round setup, approvals and coaching can be reviewed without Google sign-in.
All names and results are sample data; score calculation is simulated. Local
test uploads stay in browser memory. Reset sample data or refresh to discard
changes. This adapter does not call Supabase, send emails or create real auth
tokens. It is dynamically imported only under `import.meta.env.DEV` on localhost
and is excluded from production builds.

Try real sign-in switches back to the existing authenticated backend. The
observed local login blocker is Google's `origin not allowed` error. Add the
exact local origin to the Google OAuth client's Authorized JavaScript origins
before testing real local login. Google documents adding both `http://localhost`
and the exact port origin, such as `http://localhost:5175`; `127.0.0.1` is a
different origin and also needs its own exact entry if used. No Google settings
or production authentication permissions are changed by the preview adapter.

## Competitor journey

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
