import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import League from "./League";
import "./League.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <League />
  </StrictMode>,
);
