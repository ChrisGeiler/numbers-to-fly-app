import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import "./AccessControl.css";

type AccessRole = "owner" | "user";
type AccessState = "checking" | "signed-out" | "allowed" | "denied" | "error";

type AccessRecord = {
  email: string;
  role: AccessRole;
  created_at: string;
};

type AccessControlProps = {
  children: ReactNode;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GOOGLE_CLIENT_ID =
  import.meta.env.VITE_GOOGLE_CLIENT_ID ??
  "287085993983-2l0111ru255rff5rjeaa7fimprq6fe0a.apps.googleusercontent.com";
const PUBLIC_BASE_URL = import.meta.env.BASE_URL;
const DEMO_SLIDES = [
  {
    src: `${PUBLIC_BASE_URL}demo/01-home.jpg`,
    title: "Choose your training tool",
    description:
      "Move from planning to GPS analysis, flight-window practice, FlySight setup, and rules guidance.",
    alt: "Numbers to Fly home screen with the main training tools",
  },
  {
    src: `${PUBLIC_BASE_URL}demo/02-analyzer.jpg`,
    title: "Review FlySight performance",
    description:
      "Import a FlySight track to see competition-window scores, flight metrics, and performance graphs.",
    alt: "Anonymized GPS Track Analyzer results showing wingsuit performance metrics",
  },
  {
    src: `${PUBLIC_BASE_URL}demo/03-numbers.jpg`,
    title: "Find your starting numbers",
    description:
      "Estimate useful speed and glide-ratio targets from pilot measurements and suit setup.",
    alt: "Find your Numbers screen with example pilot details and estimated targets",
  },
  {
    src: `${PUBLIC_BASE_URL}demo/04-config.jpg`,
    title: "Build a FlySight configuration",
    description:
      "Generate task-specific FlySight tone and alarm settings for training.",
    alt: "FlySight Config Builder set up for a distance task",
  },
] as const;

type GoogleCredentialResponse = {
  credential?: string;
};

type GoogleIdentityServices = {
  accounts: {
    id: {
      initialize: (options: {
        client_id: string;
        callback: (response: GoogleCredentialResponse) => void;
        nonce?: string;
        use_fedcm_for_prompt?: boolean;
      }) => void;
      renderButton: (
        parent: HTMLElement,
        options: {
          type: "standard";
          theme: "outline";
          size: "large";
          shape: "rectangular";
          text: "continue_with";
          logo_alignment: "left";
          width: number;
        },
      ) => void;
    };
  };
};

let googleIdentityScriptPromise: Promise<GoogleIdentityServices> | null = null;

function getGoogleIdentityServices() {
  return (window as Window & { google?: GoogleIdentityServices }).google;
}

function loadGoogleIdentityServices() {
  const loadedGoogle = getGoogleIdentityServices();
  if (loadedGoogle) {
    return Promise.resolve(loadedGoogle);
  }

  if (googleIdentityScriptPromise) {
    return googleIdentityScriptPromise;
  }

  googleIdentityScriptPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]',
    );
    const script = existingScript ?? document.createElement("script");

    const handleLoad = () => {
      const google = getGoogleIdentityServices();
      if (google) {
        resolve(google);
      } else {
        googleIdentityScriptPromise = null;
        reject(new Error("Google sign-in did not load correctly."));
      }
    };

    const handleError = () => {
      googleIdentityScriptPromise = null;
      reject(new Error("Google sign-in could not be loaded."));
    };

    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });

    if (!existingScript) {
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });

  return googleIdentityScriptPromise;
}

async function createGoogleSignInNonce() {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = btoa(String.fromCharCode(...randomBytes));
  const encodedNonce = new TextEncoder().encode(nonce);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encodedNonce);
  const hashedNonce = Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return { nonce, hashedNonce };
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function getAuthRedirectUrl() {
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString();
}

function GoogleAccessSignInButton({
  busy,
  onCredential,
  onError,
}: {
  busy: boolean;
  onCredential: (credential: string, nonce: string) => void;
  onError: (message: string) => void;
}) {
  const buttonContainerRef = useRef<HTMLDivElement>(null);
  const credentialHandlerRef = useRef(onCredential);
  const errorHandlerRef = useRef(onError);

  useEffect(() => {
    credentialHandlerRef.current = onCredential;
    errorHandlerRef.current = onError;
  }, [onCredential, onError]);

  useEffect(() => {
    let active = true;

    void Promise.all([
      loadGoogleIdentityServices(),
      createGoogleSignInNonce(),
    ])
      .then(([google, { nonce, hashedNonce }]) => {
        const container = buttonContainerRef.current;
        if (!active || !container) {
          return;
        }

        google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: (response) => {
            if (response.credential) {
              credentialHandlerRef.current(response.credential, nonce);
            } else {
              errorHandlerRef.current(
                "Google did not return a sign-in credential. Please try again.",
              );
            }
          },
          nonce: hashedNonce,
          use_fedcm_for_prompt: true,
        });

        container.replaceChildren();
        google.accounts.id.renderButton(container, {
          type: "standard",
          theme: "outline",
          size: "large",
          shape: "rectangular",
          text: "continue_with",
          logo_alignment: "left",
          width: Math.max(200, Math.min(400, container.clientWidth)),
        });
      })
      .catch((error: unknown) => {
        if (active) {
          errorHandlerRef.current(
            error instanceof Error
              ? error.message
              : "Google sign-in could not be loaded.",
          );
        }
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <div
      className={`access-google-sign-in${busy ? " is-busy" : ""}`}
      aria-busy={busy}
      ref={buttonContainerRef}
    />
  );
}

function AppDemoCarousel() {
  const [activeSlide, setActiveSlide] = useState(0);
  const touchStartX = useRef<number | null>(null);
  const slide = DEMO_SLIDES[activeSlide];

  function showPreviousSlide() {
    setActiveSlide(
      (current) => (current - 1 + DEMO_SLIDES.length) % DEMO_SLIDES.length,
    );
  }

  function showNextSlide() {
    setActiveSlide((current) => (current + 1) % DEMO_SLIDES.length);
  }

  return (
    <section
      className="access-demo"
      aria-labelledby="access-demo-title"
      aria-roledescription="carousel"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          showPreviousSlide();
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          showNextSlide();
        }
      }}
    >
      <div className="access-demo-heading">
        <div>
          <p className="access-eyebrow">App preview</p>
          <h2 id="access-demo-title">See what is inside</h2>
        </div>
        <span>
          {activeSlide + 1} / {DEMO_SLIDES.length}
        </span>
      </div>

      <div
        className="access-demo-frame"
        onTouchStart={(event) => {
          touchStartX.current = event.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(event) => {
          const startX = touchStartX.current;
          const endX = event.changedTouches[0]?.clientX;
          touchStartX.current = null;

          if (startX === null || endX === undefined) {
            return;
          }

          const swipeDistance = endX - startX;
          if (Math.abs(swipeDistance) < 45) {
            return;
          }

          if (swipeDistance > 0) {
            showPreviousSlide();
          } else {
            showNextSlide();
          }
        }}
      >
        <img
          key={slide.src}
          src={slide.src}
          alt={slide.alt}
          loading={activeSlide === 0 ? "eager" : "lazy"}
        />
        <button
          type="button"
          className="access-demo-arrow access-demo-arrow-previous"
          onClick={showPreviousSlide}
          aria-label="Show previous app screenshot"
        >
          ‹
        </button>
        <button
          type="button"
          className="access-demo-arrow access-demo-arrow-next"
          onClick={showNextSlide}
          aria-label="Show next app screenshot"
        >
          ›
        </button>
      </div>

      <div className="access-demo-caption" aria-live="polite">
        <h3>{slide.title}</h3>
        <p>{slide.description}</p>
      </div>

      <div className="access-demo-dots" aria-label="Choose an app screenshot">
        {DEMO_SLIDES.map((demoSlide, index) => (
          <button
            type="button"
            key={demoSlide.src}
            className={index === activeSlide ? "is-active" : ""}
            onClick={() => setActiveSlide(index)}
            aria-label={`Show screenshot ${index + 1}: ${demoSlide.title}`}
            aria-current={index === activeSlide ? "true" : undefined}
          />
        ))}
      </div>
      <p className="access-demo-hint">Swipe, use the arrows, or press ← and →.</p>
    </section>
  );
}

function AccessManager({
  onClose,
}: {
  onClose: () => void;
}) {
  const [users, setUsers] = useState<AccessRecord[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setStatus("");

    const { data, error } = await supabase
      .from("app_access")
      .select("email, role, created_at")
      .order("role", { ascending: true })
      .order("email", { ascending: true });

    if (error) {
      setStatus("The access list could not be loaded. Please try again.");
    } else {
      setUsers((data ?? []) as AccessRecord[]);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  async function addUser() {
    const email = normalizeEmail(newEmail);

    if (!EMAIL_PATTERN.test(email)) {
      setStatus("Enter a valid email address.");
      return;
    }

    setSaving(true);
    setStatus("");

    const { error } = await supabase.from("app_access").upsert(
      {
        email,
        role: "user",
      },
      {
        onConflict: "email",
        ignoreDuplicates: true,
      },
    );

    if (error) {
      setStatus(error.message);
    } else {
      setNewEmail("");
      await loadUsers();
      setStatus(`${email} can now use the app.`);
    }

    setSaving(false);
  }

  async function removeUser(email: string) {
    setSaving(true);
    setStatus("");

    const { error } = await supabase
      .from("app_access")
      .delete()
      .eq("email", email)
      .eq("role", "user");

    if (error) {
      setStatus(error.message);
    } else {
      await loadUsers();
      setStatus(`${email} no longer has access.`);
    }

    setSaving(false);
  }

  return (
    <div
      className="access-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="access-manager-title"
      onClick={onClose}
    >
      <section
        className="access-manager"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="access-modal-close"
          onClick={onClose}
          aria-label="Close access manager"
        >
          ×
        </button>

        <p className="access-eyebrow">Owner controls</p>
        <h2 id="access-manager-title">Manage access</h2>
        <p className="access-description">
          Add an email to let that person sign in and use Numbers to Fly.
        </p>

        <div className="access-add-user">
          <label htmlFor="access-email">Email address</label>
          <div className="access-add-row">
            <input
              id="access-email"
              type="email"
              value={newEmail}
              placeholder="pilot@example.com"
              autoComplete="off"
              onChange={(event) => setNewEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !saving) {
                  void addUser();
                }
              }}
            />
            <button
              type="button"
              onClick={() => void addUser()}
              disabled={saving || !newEmail.trim()}
            >
              Add user
            </button>
          </div>
        </div>

        <div className="access-user-list" aria-live="polite">
          <div className="access-list-heading">
            <h3>People with access</h3>
            <span>{users.length}</span>
          </div>

          {loading ? (
            <p className="access-muted">Loading access list…</p>
          ) : (
            users.map((user) => (
              <div className="access-user-row" key={user.email}>
                <div>
                  <strong>{user.email}</strong>
                  <span>{user.role === "owner" ? "Owner" : "Allowed user"}</span>
                </div>
                {user.role === "user" && (
                  <button
                    type="button"
                    className="access-remove-button"
                    onClick={() => void removeUser(user.email)}
                    disabled={saving}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        {status && (
          <p className="access-status" aria-live="polite">
            {status}
          </p>
        )}
      </section>
    </div>
  );
}

export default function AccessControl({ children }: AccessControlProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [accessState, setAccessState] = useState<AccessState>("checking");
  const [accessRole, setAccessRole] = useState<AccessRole | null>(null);
  const [email, setEmail] = useState("");
  const [authStatus, setAuthStatus] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [showAccessManager, setShowAccessManager] = useState(false);
  const [accessCheckNumber, setAccessCheckNumber] = useState(0);

  useEffect(() => {
    let active = true;

    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active) {
        return;
      }

      if (error) {
        setAccessState("error");
        return;
      }

      setSession(data.session);
      if (!data.session) {
        setAccessState("signed-out");
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAccessRole(null);
      setAccessState(nextSession ? "checking" : "signed-out");
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;

    if (!session?.user.email) {
      return () => {
        active = false;
      };
    }

    const signedInEmail = normalizeEmail(session.user.email);
    setAccessState("checking");

    void supabase
      .from("app_access")
      .select("role")
      .eq("email", signedInEmail)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) {
          return;
        }

        if (error) {
          console.error("Access check failed:", error.message);
          setAccessRole(null);
          setAccessState("error");
        } else if (data) {
          setAccessRole(data.role as AccessRole);
          setAccessState("allowed");
          setAuthStatus("");
        } else {
          setAccessRole(null);
          setAccessState("denied");
        }
      });

    return () => {
      active = false;
    };
  }, [session, accessCheckNumber]);

  async function sendSignInLink() {
    const normalizedEmail = normalizeEmail(email);

    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      setAuthStatus("Enter a valid email address.");
      return;
    }

    setAuthBusy(true);
    setAuthStatus("");

    const { error } = await supabase.auth.signInWithOtp({
      email: normalizedEmail,
      options: {
        emailRedirectTo: getAuthRedirectUrl(),
        shouldCreateUser: true,
      },
    });

    if (error) {
      setAuthStatus(error.message);
    } else {
      setAuthStatus(`Check ${normalizedEmail} for your secure sign-in link.`);
    }

    setAuthBusy(false);
  }

  async function signInWithGoogle(credential: string, nonce: string) {
    setAuthBusy(true);
    setAuthStatus("");

    const { error } = await supabase.auth.signInWithIdToken({
      provider: "google",
      token: credential,
      nonce,
    });

    if (error) {
      setAuthStatus(error.message);
    }

    setAuthBusy(false);
  }

  async function signOut() {
    setAuthBusy(true);
    setAuthStatus("");
    const { error } = await supabase.auth.signOut();

    if (error) {
      setAuthStatus(error.message);
    } else {
      setSession(null);
      setAccessRole(null);
      setAccessState("signed-out");
    }

    setAuthBusy(false);
  }

  if (accessState === "allowed") {
    return (
      <>
        {children}
        {accessRole === "owner" && (
          <>
            <button
              type="button"
              className="access-manage-launcher"
              onClick={() => setShowAccessManager(true)}
            >
              Manage access
            </button>
            {showAccessManager && (
              <AccessManager onClose={() => setShowAccessManager(false)} />
            )}
          </>
        )}
      </>
    );
  }

  return (
    <main className="access-gate">
      <div className="access-public-shell">
        <section className="access-gate-card">
        <div className="access-gate-mark" aria-hidden="true">
          NF
        </div>
        <p className="access-eyebrow">Private access</p>
        <h1>Numbers to Fly</h1>

        {accessState === "checking" && (
          <>
            <p>Checking your access…</p>
            <div className="access-loader" aria-hidden="true" />
          </>
        )}

        {accessState === "signed-out" && (
          <>
            <p>
              Sign in with an approved email address to continue to the app.
            </p>
            <GoogleAccessSignInButton
              busy={authBusy}
              onCredential={(credential, nonce) =>
                void signInWithGoogle(credential, nonce)
              }
              onError={setAuthStatus}
            />
            <div className="access-sign-in-divider" aria-hidden="true">
              <span>or use an email link</span>
            </div>
            <label htmlFor="sign-in-email">Email address</label>
            <input
              id="sign-in-email"
              type="email"
              value={email}
              placeholder="you@example.com"
              autoComplete="email"
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !authBusy) {
                  void sendSignInLink();
                }
              }}
            />
            <button
              type="button"
              className="access-primary-button"
              onClick={() => void sendSignInLink()}
              disabled={authBusy || !email.trim()}
            >
              {authBusy ? "Sending…" : "Email me a sign-in link"}
            </button>
            <small>No password is required.</small>
          </>
        )}

        {accessState === "denied" && (
          <>
            <p>
              <strong>{session?.user.email}</strong> has not been given access
              to this app.
            </p>
            <p className="access-muted">
              Ask the owner to add this email, then try again.
            </p>
            <button
              type="button"
              className="access-primary-button"
              onClick={() => void signOut()}
              disabled={authBusy}
            >
              Sign in with another email
            </button>
          </>
        )}

        {accessState === "error" && (
          <>
            <p>The access list could not be checked.</p>
            <p className="access-muted">
              Please retry. If the problem continues, contact the app owner.
            </p>
            <button
              type="button"
              className="access-primary-button"
              onClick={() => setAccessCheckNumber((current) => current + 1)}
            >
              Try again
            </button>
            {session && (
              <button
                type="button"
                className="access-secondary-button"
                onClick={() => void signOut()}
                disabled={authBusy}
              >
                Sign out
              </button>
            )}
          </>
        )}

          {authStatus && (
            <p className="access-status" aria-live="polite">
              {authStatus}
            </p>
          )}

          <div className="access-public-links">
            <a href={`${PUBLIC_BASE_URL}privacy.html`}>Privacy policy</a>
            <a href="mailto:flywithcruza@gmail.com">Contact the app owner</a>
          </div>
        </section>

        <AppDemoCarousel />

        <section className="access-about" aria-labelledby="access-about-title">
          <p className="access-eyebrow">Performance wingsuiting toolkit</p>
          <h2 id="access-about-title">Plan, fly, and review with better data</h2>
          <p>
            Numbers to Fly helps approved pilots plan target numbers, practise a
            competition window, review FlySight GPS tracks, build FlySight
            settings, and search wingsuit competition rules.
          </p>
          <ul>
            <li>Estimate speed and glide-ratio targets for your suit.</li>
            <li>Review competition-window metrics from a FlySight CSV.</li>
            <li>Generate task-specific tones and altitude reminders.</li>
          </ul>
          <p className="access-about-note">
            The app is private. Access is granted by the owner to individual
            email addresses.
          </p>
        </section>
      </div>
    </main>
  );
}
