import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import League from "./League";
import "./League.css";

const root = createRoot(document.getElementById("root")!);
if (
  import.meta.env.DEV &&
  ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)
) {
  void import("./LeagueDevPreview").then(({ default: LeagueDevPreview }) => {
    root.render(
      <StrictMode>
        <LeagueDevPreview />
      </StrictMode>,
    );
  });
} else {
  root.render(
    <StrictMode>
      <League />
    </StrictMode>,
  );
}
