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
      <h2 id="league-app-promo-title">Do you need help getting started..?<br />There's an app for that!</h2>
      <p>Drawing on 12 years of performance flying, three World Championship titles and years of coaching, Chris Geiler has brought his knowledge together in Fly the Numbers: a step-by-step introduction to performance flying.</p>
      <p>Understand each task and how to fly it, with starting targets tailored to your weight, height and suit type. Explore how wind conditions affect your flight and your lane, then use that information to plan your approach.</p>
      <p>Keep your GPS tracks in a logbook, sort them by task and review automatically calculated metrics to assess and improve your flying. Explore each jump in an interactive analyser with wind-corrected information, or compare flights side by side with synchronised playback. Choose a competition reference point to see how your track fits within the lane and check for estimated lane penalties.</p>
      <p>Create task-specific FlySight configuration files to download or copy, and preview the tones and alarms alongside a recorded flight. A searchable FAI rules reference keeps the competition requirements close at hand—from planning your jump to reviewing the result.</p>
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
      <p>Fly the Numbers is a private tool that requires activation. Activation includes a video call with Chris to walk you through the app, answer your questions and help you get started with confidence.</p>
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
