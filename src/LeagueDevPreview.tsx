import { useMemo, useState } from "react";
import League from "./League";
import {
  createLeaguePreviewClient,
  createPreviewStore,
} from "./leaguePreviewClient";
import type { PreviewRole } from "./leaguePreviewClient";

export default function LeagueDevPreview() {
  const [role, setRole] = useState<PreviewRole>("organiser");
  const [store, setStore] = useState(createPreviewStore);
  const [realLogin, setRealLogin] = useState(false);
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
          <strong>Development preview</strong>
          <p>
            {realLogin
              ? "Real sign-in: Google must authorise this local address. Nothing has been published."
              : "Sample data only. No login needed, no live uploads or emails. Calculations are simulated."}
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
          <button onClick={() => setRealLogin((current) => !current)}>
            {realLogin ? "Back to sample preview" : "Try real sign-in"}
          </button>
          {!realLogin && (
            <button onClick={() => setStore(createPreviewStore())}>
              Reset sample data
            </button>
          )}
        </div>
      </aside>
      {realLogin ? (
        <League key="real" />
      ) : (
        <League
          key={`${role}-${store.rounds[0]?.id}-${store.entries[0]?.submitted_at}`}
          client={client}
          preview
        />
      )}
    </>
  );
}
