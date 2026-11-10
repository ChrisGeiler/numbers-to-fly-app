import { useEffect, useRef } from "react";
import { supabase } from "./supabase";

type GoogleApi = {
  accounts: {
    id: {
      initialize: (options: {
        client_id: string;
        nonce: string;
        callback: (result: { credential?: string }) => void;
      }) => void;
      renderButton: (
        parent: HTMLElement,
        options: {
          type: string;
          theme: string;
          size: string;
          text: string;
          width: number;
        },
      ) => void;
    };
  };
};

// The same Google client as the existing app; ID-token sign-in stays on this page.
const clientId =
  import.meta.env.VITE_GOOGLE_CLIENT_ID ??
  "287085993983-2l0111ru255rff5rjeaa7fimprq6fe0a.apps.googleusercontent.com";
let googleScript: Promise<GoogleApi> | undefined;
function loadGoogle(): Promise<GoogleApi> {
  const getApi = () => (window as Window & { google?: GoogleApi }).google;
  if (getApi()) return Promise.resolve(getApi()!);
  if (!googleScript)
    googleScript = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.onload = () =>
        getApi()
          ? resolve(getApi()!)
          : reject(
              new Error("Google sign-in is unavailable. Use email instead."),
            );
      script.onerror = () => {
        googleScript = undefined;
        reject(new Error("Google sign-in could not load. Use email instead."));
      };
      document.head.appendChild(script);
    });
  return googleScript;
}

export default function LeagueGoogleSignIn({
  onStatus,
}: {
  onStatus: (status: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const google = await loadGoogle();
        const nonce = Array.from(
          crypto.getRandomValues(new Uint8Array(32)),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("");
        const hash = Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(nonce),
            ),
          ),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("");
        if (cancelled || !host.current) return;
        google.accounts.id.initialize({
          client_id: clientId,
          nonce: hash,
          callback: (result) => {
            if (!result.credential || cancelled) return;
            onStatus("Signing in…");
            void supabase.auth
              .signInWithIdToken({
                provider: "google",
                token: result.credential,
                nonce,
              })
              .then(({ error }) => {
                if (!cancelled) onStatus(error?.message ?? "Signed in.");
              });
          },
        });
        google.accounts.id.renderButton(host.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          width: Math.min(320, host.current.clientWidth),
        });
      } catch (error) {
        if (!cancelled)
          onStatus(
            error instanceof Error ? error.message : "Use email to sign in.",
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onStatus]);
  return <div ref={host} className="league-google" />;
}
