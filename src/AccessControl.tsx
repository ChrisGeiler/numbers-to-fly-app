import { useCallback, useEffect, useState } from "react";
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

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function getAuthRedirectUrl() {
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString();
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
      </section>
    </main>
  );
}
