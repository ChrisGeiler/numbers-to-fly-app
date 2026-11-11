import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { createLeagueWeatherService } from "./server/leagueWeather";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const weather = createLeagueWeatherService({
    username: env.METEOMATICS_USERNAME ?? process.env.METEOMATICS_USERNAME,
    password: env.METEOMATICS_PASSWORD ?? process.env.METEOMATICS_PASSWORD,
  });
  return {
  plugins: [react(), {
    name: "local-league-weather",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/league-winds", async (request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        if (request.method !== "POST" || request.headers.origin !== `http://${request.headers.host}` ||
          !request.headers["content-type"]?.startsWith("application/json")) {
          response.statusCode = 403;
          response.end(JSON.stringify({ error: "Same-origin JSON POST required." }));
          return;
        }
        try {
          let body = "";
          for await (const chunk of request) {
            body += chunk.toString();
            if (body.length > 1000000) throw new Error("Weather request is too large.");
          }
          const { points } = JSON.parse(body);
          if (!Array.isArray(points) || points.length > 10000) throw new Error("Invalid weather window.");
          response.end(JSON.stringify(await weather(points)));
        } catch (error) {
          response.statusCode = 503;
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Weather lookup failed." }));
        }
      });
    },
  }],
  base: "/",
  server: {
    // Windows can briefly lock screenshots while they are copied or synced.
    // Polling avoids native watcher EBUSY errors terminating the dev server.
    watch: process.platform === "win32" ? { usePolling: true, interval: 500 } : undefined,
  },
  build: {
    rollupOptions: {
      input: { app: "index.html", league: "league.html", ozleague: "ozleague/index.html" },
    },
  },
};
});
