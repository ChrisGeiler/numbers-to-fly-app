import { useRef, useState } from "react";

const features = [
  { title: "Find your numbers", image: "/demo/find-your-numbers-preview.png", alt: "Find your Numbers tool showing flying targets and achievable performance ranges", text: "Explore starting targets for your suit and body details, then refine your flying numbers with your jump data." },
  { title: "Create your config", image: "/demo/flysight-config-preview.png", alt: "FlySight configuration page showing alarm elevations, flight audio simulation and a generated configuration file", text: "Create a task-specific FlySight configuration file with tones and alarms for your next training jump." },
  { title: "Review and refine", image: "/demo/gps-analyser-starcruza.png", alt: "GPS analyser from Starcruza showing recorded jumps, detailed jump metrics and an interactive flight graph", text: "Explore your speed, glide and sink rate. Review each flight and adjust your targets as you progress." },
  { title: "Visualise the wind", image: "/demo/wind-window-preview.png", alt: "Map of a performance flight lane with wind speeds and direction arrows through the window", text: "See how wind speed and direction change through the 2,500–1,500 m performance window. Visualise the forecast wind effects on your flight path while flying your lane." },
];

export default function LeagueAppPromo({ appAccess }: { appAccess: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState(features[0]);
  return (
    <section className="league-section league-app-promo" aria-labelledby="league-app-promo-title">
      <p className="league-eyebrow">FLY THE NUMBERS</p>
      <h2 id="league-app-promo-title">Find your numbers.<br />Take them into your next jump.</h2>
      <p>Analyse your flights, find your target numbers to fly, understand the effects of winds while flying your lane and create FlySight config files for your next training jump.</p>
      <div className="league-promo-grid">
        {features.map(feature => (
          <article key={feature.title}>
            <button type="button" className="league-promo-preview" aria-label={`Enlarge ${feature.title} screenshot`}
              onClick={() => { setSelected(feature); dialog.current?.showModal(); }}>
              <span className="league-promo-crop">
                <img src={feature.image} alt={feature.alt} loading="lazy"
                  style={{ height: feature === features[2] ? "108%" : "190%", transform: `translate(${feature === features[0] ? "-54%" : "-50%"}, -50%)` }} />
              </span>
              <span>View screenshot ↗</span>
            </button>
            <h3>{feature.title}</h3>
            <p>{feature.text}</p>
          </article>
        ))}
      </div>
      <div className="league-promo-action">
        <a className="league-button" href={appAccess ? "/" : "mailto:flywithcruza@gmail.com?subject=Fly%20the%20Numbers%20access%20request"}>
          {appAccess ? "Open Fly the Numbers" : "Request access to Fly the Numbers"}
        </a>
        {!appAccess && <p className="league-caption">Access is approved separately from league registration.</p>}
      </div>
      <dialog ref={dialog} className="league-promo-dialog" aria-labelledby="league-promo-preview-title">
        <div className="league-section-top">
          <h3 id="league-promo-preview-title">{selected.title}</h3>
          <button type="button" onClick={() => dialog.current?.close()}>Close preview</button>
        </div>
        <img src={selected.image} alt={selected.alt} />
      </dialog>
    </section>
  );
}
