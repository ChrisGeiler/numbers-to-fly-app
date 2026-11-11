import { dropZoneReferences, elevationReference } from "./leagueDropZones";

export default function LeagueElevationReferences() {
  return (
    <section className="league-section league-elevations" id="dz-elevations">
      <p className="league-eyebrow">KNOW YOUR REFERENCE</p>
      <h2>Drop zone elevations.</h2>
      <p>
        Landing-area references for wingsuit pilots, using Skyderby place records where available. AMSL means
        above mean sea level. Airfield elevations can differ from the parachute landing area.
        Confirm the actual DZ elevation before using it for scoring or flight
        planning; use current operator information and aviation publications.
      </p>
      <details>
        <summary>View all 15 locations and sources</summary>
        <p className="league-caption">
          Sources researched 11 November 2026. Publication dates and outstanding
          confirmations are shown below. Blank values have not been assumed to be
          sea level. Selecting a DZ fills its Skyderby elevation into the jump import. Unlisted elevations require manual entry.
        </p>
        <div className="league-table-wrap">
          <table>
            <thead><tr><th>Drop zone / site</th><th>Landing-area elevation</th><th>Basis and source</th></tr></thead>
            <tbody>
              {dropZoneReferences.map((reference) => (
                <tr key={reference.name}>
                  <th scope="row">{reference.name}<small>{reference.site}</small></th>
                  <td>{elevationReference(reference)}</td>
                  <td>
                    <strong>{reference.basis}</strong>
                    <p>{reference.note}</p>
                    <a href={reference.url} target="_blank" rel="noreferrer">{reference.source} ↗</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
