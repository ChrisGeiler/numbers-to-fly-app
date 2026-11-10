import { useEffect, useMemo, useState } from "react";
import League from "./League";
import {
  createLeaguePreviewClient,
  createPreviewStore,
} from "./leaguePreviewClient";
import type { PreviewRole } from "./leaguePreviewClient";
import { readLeagueTestStore, writeLeagueTestStore } from "./leagueTestStorage";

export default function LeagueDevPreview() {
  const [role, setRole] = useState<PreviewRole>("organiser");
  const [store, setStore] = useState(createPreviewStore);
  const [realLogin, setRealLogin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [storageError, setStorageError] = useState("");
  function persistentStore(next: ReturnType<typeof createPreviewStore>) {
    next.persist = () => writeLeagueTestStore(next);
    return next;
  }
  useEffect(() => {
    let active = true;
    void readLeagueTestStore()
      .then((saved) => {
        if (!active) return;
        const next = createPreviewStore();
        if (saved) {
          next.rounds = saved.rounds;
          next.entries = saved.entries;
          next.registrations = saved.registrations ?? [];
          next.files = new Map(saved.files);
        }
        setStore(persistentStore(next));
      })
      .catch((error) => {
        if (active)
          setStorageError(
            error instanceof Error
              ? error.message
              : "Local storage unavailable; this session will not survive refresh.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function resetTest() {
    if (
      !window.confirm(
        "Delete all local test registrations, tracks, results and coaching feedback? This does not affect Supabase or official results.",
      )
    )
      return;
    const next = persistentStore(createPreviewStore());
    try {
      await next.persist?.();
      setStore(next);
      setStorageError("");
    } catch (error) {
      setStorageError(
        error instanceof Error
          ? error.message
          : "Could not reset local test data.",
      );
    }
  }
  const client = useMemo(
    () => createLeaguePreviewClient(store, role),
    [store, role],
  );
  return (
    <>
      <aside
        className="league-dev-toolbar"
        aria-label="Development preview controls"
      >
        <div>
          <strong>Local development test</strong>
          <p>
            {realLogin
              ? "Real sign-in: Google must authorise this local address. Nothing has been published."
              : "Real uploaded tracks and archived-wind calculations. Accounts and results stay local; nothing is published or uploaded to Supabase."}
          </p>
        </div>
        <div className="league-dev-controls">
          {!realLogin && (
            <label>
              View as
              <select
                aria-label="Preview role"
                value={role}
                onChange={(e) => setRole(e.target.value as PreviewRole)}
              >
                <option value="visitor">Visitor</option>
                <option value="competitor">Competitor</option>
                <option value="organiser">Organiser</option>
              </select>
            </label>
          )}
          <button
            disabled={loading}
            onClick={() => setRealLogin((current) => !current)}
          >
            {realLogin ? "Back to local test" : "Try real sign-in"}
          </button>
          {!realLogin && (
            <button disabled={loading} onClick={() => void resetTest()}>
              Reset local test
            </button>
          )}
        </div>
      </aside>
      {storageError && (
        <p className="league-notice" role="alert">
          {storageError}
        </p>
      )}
      {loading ? (
        <p className="league-notice">Loading local test tracks…</p>
      ) : realLogin ? (
        <League key="real" />
      ) : (
        <League key={`${role}-${store.instanceId}`} client={client} preview />
      )}
    </>
  );
}
