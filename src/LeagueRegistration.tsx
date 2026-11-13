import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { supabase } from "./supabase";

export type RegistrationAccess =
  "checking" | "unregistered" | "pending" | "approved" | "rejected" | "error";
type Registration = {
  user_id: string;
  public_name: string;
  region: string;
  email: string;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  review_note: string | null;
};
export default function LeagueRegistration({
  client,
  userId,
  owner,
  regions,
  homeState,
  onHomeStateChange,
  onAccessChange,
  preview = false,
}: {
  client: typeof supabase;
  userId: string;
  owner: boolean;
  regions: string[];
  homeState: string;
  onHomeStateChange: (state: string) => void;
  onAccessChange: (status: RegistrationAccess) => void;
  preview?: boolean;
}) {
  const [requests, setRequests] = useState<Registration[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [limit, setLimit] = useState(100);
  const requestVersion = useRef(0);
  const own = requests.find((row) => row.user_id === userId);
  useEffect(() => {
    if (own?.region && regions.includes(own.region)) onHomeStateChange(own.region);
  }, [own?.region, regions, onHomeStateChange]);
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    let query = client
      .from("league_registrations")
      .select(
        "user_id,public_name,region,email,status,requested_at,review_note",
      )
      .order("requested_at", { ascending: false })
      .limit(limit);
    if (!owner) query = query.eq("user_id", userId);
    const response = await query;
    if (version !== requestVersion.current) return;
    if (response.error) {
      setStatus(
        "Registration could not be checked. Please retry before uploading.",
      );
      onAccessChange(owner ? "approved" : "error");
    } else {
      const rows = (response.data ?? []) as Registration[];
      setRequests(rows);
      onAccessChange(
        owner
          ? "approved"
          : (rows.find((row) => row.user_id === userId)?.status ??
              "unregistered"),
      );
    }
    setLoading(false);
  }, [client, userId, owner, limit, onAccessChange]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    onAccessChange(owner ? "approved" : "checking");
    void refresh().catch(() => {
      if (active) {
        setStatus("Registration could not be checked. Please retry.");
        onAccessChange(owner ? "approved" : "error");
        setLoading(false);
      }
    });
    return () => {
      active = false;
      requestVersion.current++;
    };
  }, [refresh, owner, onAccessChange]);
  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setStatus("");
    try {
      const response = await client
        .from("league_registrations")
        .insert({
          user_id: userId,
          public_name: String(form.get("public_name")).trim(),
          region: homeState,
        });
      if (response.error) throw new Error(response.error.message);
      setStatus(
        "Registration requested. You can enter rounds once the organiser approves you.",
      );
      await refresh();
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Could not request registration.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function review(
    applicant: Registration,
    decision: "approved" | "rejected",
  ) {
    setBusy(true);
    setStatus("");
    try {
      const response = await client.rpc("league_review_registration", {
        applicant_id: applicant.user_id,
        decision,
        note: notes[applicant.user_id] ?? applicant.review_note ?? "",
      });
      if (response.error) throw new Error(response.error.message);
      await refresh();
      setStatus(
        decision === "approved"
          ? `${applicant.public_name} can now submit round entries.`
          : `${applicant.public_name} no longer has entry access. Existing results are retained.`,
      );
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Could not review registration.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="league-section league-registration" id="registration">
      <div className="league-section-top">
        <div>
          <p className="league-eyebrow">
            {owner ? "ORGANISER WORKSPACE" : "BEFORE YOUR FIRST ROUND"}
          </p>
          <h2>
            {owner ? "Competitor registrations" : "Register for the league"}
          </h2>
        </div>
        <button
          className="league-secondary"
          disabled={busy || loading}
          onClick={() => void refresh()}
        >
          Refresh registrations ↻
        </button>
      </div>
      <p className="league-caption">
        Registration grants league entry access only after organiser approval.
        Every uploaded jump is reviewed separately. It does not grant access to
        Numbers to Fly.
      </p>
      {status && (
        <p className="league-notice" role="status">
          {status}
        </p>
      )}
      {loading ? (
        <p>Checking registration…</p>
      ) : owner ? (
        <>
          {requests.length === 0 ? (
            <p>
              No registration requests yet.{preview && " Switch to Competitor in the local test to request entry."}
            </p>
          ) : (
            <div className="league-entry-list">
              {requests.map((applicant) => (
                <article className="league-review-card" key={applicant.user_id}>
                  <div className="league-section-top">
                    <h3>{applicant.public_name}</h3>
                    <span className={`league-badge ${applicant.status}`}>
                      {applicant.status === "rejected"
                        ? "Not approved"
                        : applicant.status}
                    </span>
                  </div>
                  <p>
                    {applicant.region} · {applicant.email}
                  </p>
                  <p className="league-caption">
                    Requested{" "}
                    {new Date(applicant.requested_at).toLocaleString("en-AU")}
                  </p>
                  <label>
                    Registration review note
                    <textarea
                      maxLength={2000}
                      value={
                        notes[applicant.user_id] ?? applicant.review_note ?? ""
                      }
                      onChange={(event) =>
                        setNotes((current) => ({
                          ...current,
                          [applicant.user_id]: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <div className="league-review-actions">
                    <button
                      disabled={busy || applicant.status === "approved"}
                      onClick={() => void review(applicant, "approved")}
                    >
                      Approve registration
                    </button>
                    <button
                      disabled={busy || applicant.status === "rejected"}
                      onClick={() => void review(applicant, "rejected")}
                    >
                      {applicant.status === "approved"
                        ? "Revoke entry access"
                        : "Decline registration"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
          {requests.length >= limit && (
            <button
              className="league-secondary"
              onClick={() => setLimit((current) => current + 100)}
            >
              Load more registrations
            </button>
          )}
        </>
      ) : own ? (
        <div className="league-form-card">
          <h3>
            {own.status === "approved"
              ? "You’re approved to enter rounds."
              : own.status === "pending"
                ? "Your registration is awaiting approval."
                : "Your registration is not approved."}
          </h3>
          <p>
            {own.public_name} · {own.region}
          </p>
          <p>
            {own.status === "approved"
              ? "Choose an open round and upload your jump below."
              : "Round uploads are locked until the organiser approves your registration."}
          </p>
          {own.review_note && (
            <p className="league-feedback">
              <b>Organiser’s note</b>
              <br />
              {own.review_note}
            </p>
          )}
        </div>
      ) : (
        <form
          className="league-form-card"
          aria-label="League registration"
          onSubmit={register}
        >
          <h3>Request permission to enter</h3>
          <p>
            Tell the organiser who you are. Your registration details are
            visible only to you and the organiser.
          </p>
          <label>
            Competitor name
            <input
              name="public_name"
              required
              minLength={2}
              maxLength={60}
              autoComplete="name"
            />
          </label>
          <label>
            State council
            <select
              required
              value={homeState}
              onChange={(event) => onHomeStateChange(event.target.value)}
            >
              <option value="" disabled>
                Select state council
              </option>
              {regions.map((region) => (
                <option key={region}>{region}</option>
              ))}
            </select>
          </label>
          <button className="league-button" disabled={busy}>
            Request registration ↗
          </button>
        </form>
      )}
    </section>
  );
}
