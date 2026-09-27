import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError } from "./api";
import { Admin } from "./Admin";
import { Billing } from "./Billing";
import { Attendance } from "./Attendance";
import { Finance } from "./Finance";
import { Issues } from "./Issues";
import { Login, isAuthLinkPath } from "./Login";
import { Legal, isLegalPath } from "./Legal";
import { Onboarding } from "./Onboarding";
import { Materials } from "./Materials";
import { Overview } from "./Overview";
import { ProjectForm, Projects } from "./Projects";
import {
  Session,
  User,
  Project,
  Attendance as AttendanceRecord,
  Material,
  Expense,
  Issue,
  AuditEntry,
} from "./types";
import "./styles.css";

/**
 * Stripe navigates the browser straight to these paths once Checkout
 * finishes (`createCheckoutSession`'s `success_url` / `cancel_url`), so
 * `SPA_LINK_PATHS` in `server/index.ts` has to serve the shell for them or
 * a successful payment ends on a 404.
 *
 * They are in-app routes to the Billing panel rather than separate screens:
 * the panel shows the live subscription status, which is exactly what a
 * customer returning from a payment needs to confirm.
 */
const BILLING_RETURN_PATHS = ["/billing/success", "/billing/cancel"];

/**
 * The section a pathname should open on. Anything not listed falls back to
 * `overview`, so an unexpected URL keeps the existing default behaviour
 * rather than inventing a screen for it.
 */
function sectionForPath(pathname: string): string {
  const path = pathname.replace(/\/+$/, "") || "/";
  return BILLING_RETURN_PATHS.includes(path) ? "billing" : "overview";
}

function Workspace({
  session,
  onLogout,
}: {
  session: Session;
  onLogout: () => void;
}) {
  const { user } = session;
  // Lazy initialiser, because the pathname is only meaningful at mount: the
  // workspace never navigates by URL afterwards (nav clicks set `section`
  // directly), and re-deriving on every render would undo those clicks.
  const [section, setSection] = useState(() =>
    sectionForPath(window.location.pathname),
  );
  const [projects, setProjects] = useState<Project[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [companyName, setCompanyName] = useState("Your company");
  const [error, setError] = useState("");
  // Plan gates (`402`) are reported apart from `error`: a free workspace
  // genuinely does not include `audit` or `materials`, and saying so with the
  // same red text as a broken request makes a working app look broken.
  const [planNotice, setPlanNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const canPeople = user.role === "admin";
  const canAttendance = ["admin", "supervisor", "worker"].includes(user.role);
  const canMaterials = ["admin", "supervisor"].includes(user.role);
  const canFinance = ["admin", "accountant"].includes(user.role);
  const canIssues = ["admin", "supervisor"].includes(user.role);

  async function load() {
    setBusy(true);
    setError("");
    setPlanNotice("");
    // Each panel is fetched and applied on its own.
    //
    // This used to be one `Promise.all` over the raw calls with a single
    // index walk afterwards. Because one rejection rejects the whole batch,
    // a free-tier admin lost *everything*: `/materials` and `/audit` both
    // answer 402 on the free plan, so projects, users, attendance, expenses
    // and issues were all discarded and the dashboard rendered empty with
    // one misleading error. `settle` never rejects, so a panel that cannot
    // load no longer takes its neighbours down with it.
    const notices: string[] = [];
    const settle = async <T,>(
      request: Promise<T>,
      apply: (data: T) => void,
    ): Promise<void> => {
      try {
        apply(await request);
      } catch (err) {
        if (err instanceof ApiError && err.status === 402) {
          if (!notices.includes(err.message)) notices.push(err.message);
          return;
        }
        setError(
          err instanceof Error ? err.message : "Could not load workspace",
        );
      }
    };

    try {
      const calls: Promise<void>[] = [
        settle(api<{ projects: Project[] }>("/projects"), ({ projects }) =>
          setProjects(projects),
        ),
      ];
      if (canAttendance)
        calls.push(
          settle(
            api<{ attendance: AttendanceRecord[] }>("/attendance"),
            ({ attendance }) => setAttendance(attendance),
          ),
        );
      if (canMaterials)
        calls.push(
          settle(
            api<{ materials: Material[] }>("/materials"),
            ({ materials }) => setMaterials(materials),
          ),
        );
      if (canFinance)
        calls.push(
          settle(api<{ expenses: Expense[] }>("/expenses"), ({ expenses }) =>
            setExpenses(expenses),
          ),
        );
      if (canIssues)
        calls.push(
          settle(api<{ issues: Issue[] }>("/issues"), ({ issues }) =>
            setIssues(issues),
          ),
        );
      if (canPeople) {
        calls.push(
          settle(api<{ users: User[] }>("/users"), ({ users }) =>
            setUsers(users),
          ),
          settle(api<{ entries: AuditEntry[] }>("/audit"), ({ entries }) =>
            setAudit(entries),
          ),
        );
      }
      await Promise.all(calls);
      setPlanNotice(notices.join(" · "));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
    api<{ company: { name: string } }>("/company")
      .then(({ company }) => setCompanyName(company.name))
      .catch(() => undefined);
  }, [session.user.uuid]);
  async function mutate(path: string, init: RequestInit) {
    setBusy(true);
    setError("");
    try {
      await api(path, init);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }
  const budget = useMemo(
    () => projects.reduce((sum, project) => sum + Number(project.budget), 0),
    [projects],
  );
  const actual = useMemo(
    () => expenses.reduce((sum, expense) => sum + Number(expense.amount), 0),
    [expenses],
  );
  const nav = [
    { id: "overview", label: "Overview", show: true },
    { id: "projects", label: "Projects", show: true },
    { id: "attendance", label: "Attendance", show: canAttendance },
    { id: "materials", label: "Materials", show: canMaterials },
    { id: "finance", label: "Finance", show: canFinance },
    { id: "issues", label: "Safety issues", show: canIssues },
    { id: "billing", label: "Billing", show: true },
    { id: "admin", label: "Admin & audit", show: canPeople },
  ].filter((item) => item.show);

  return (
    <main className="app-shell">
      <header>
        <div>
          <div className="brand">NORTHLINE</div>
          <span className="muted">
            {companyName} · Construction lifecycle management
          </span>
        </div>
        <div className="user-actions">
          <span>
            {user.name ?? user.email} · <strong>{user.role}</strong>
          </span>
          <button className="secondary" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside>
          {nav.map((item) => (
            <button
              className={section === item.id ? "nav active" : "nav"}
              key={item.id}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </aside>
        <section className="content">
          <div className="welcome">
            <div>
              <p className="kicker">Operations brief</p>
              <h1>
                {section === "overview"
                  ? `Good morning, ${(user.name ?? "team").split(" ")[0]}.`
                  : nav.find((item) => item.id === section)?.label}
              </h1>
              <p className="muted">
                {busy
                  ? "Syncing workspace…"
                  : "Live data from your role-based workspace."}
              </p>
            </div>
            {section === "projects" && user.role === "admin" && (
              <ProjectForm
                onSubmit={(data) =>
                  mutate("/projects", {
                    method: "POST",
                    body: JSON.stringify(data),
                  })
                }
              />
            )}
          </div>
          {error && <p className="error">{error}</p>}
          {planNotice && <p className="muted">{planNotice}</p>}
          {section === "overview" && (
            <Overview
              projects={projects}
              budget={budget}
              actual={actual}
              issues={issues}
              attendance={attendance}
            />
          )}
          {section === "projects" && (
            <Projects
              projects={projects}
              canEdit={user.role === "admin"}
              onDelete={(id) => mutate(`/projects/${id}`, { method: "DELETE" })}
              onUpdate={(id, status) =>
                mutate(`/projects/${id}`, {
                  method: "PATCH",
                  body: JSON.stringify({ status }),
                })
              }
            />
          )}
          {section === "attendance" && (
            <Attendance
              data={attendance}
              projects={projects}
              user={user}
              onSubmit={(data) =>
                mutate("/attendance/check-in", {
                  method: "POST",
                  body: JSON.stringify(data),
                })
              }
              onCheckout={(id) =>
                mutate(`/attendance/${id}/check-out`, { method: "POST" })
              }
            />
          )}
          {section === "materials" && (
            <Materials
              data={materials}
              projects={projects}
              onSubmit={(data) =>
                mutate("/materials", {
                  method: "POST",
                  body: JSON.stringify(data),
                })
              }
            />
          )}
          {section === "finance" && (
            <Finance
              data={expenses}
              projects={projects}
              onSubmit={(data) =>
                mutate("/expenses", {
                  method: "POST",
                  body: JSON.stringify(data),
                })
              }
            />
          )}
          {section === "issues" && (
            <Issues
              data={issues}
              projects={projects}
              onSubmit={(data) =>
                mutate("/issues", { method: "POST", body: data })
              }
            />
          )}
          {section === "billing" && (
            <Billing canManage={user.role === "admin"} />
          )}
          {section === "admin" && (
            <Admin
              users={users}
              audit={audit}
              projects={projects}
              onReload={load}
            />
          )}
        </section>
      </div>
      {/* In-app route to the legal surface (#10) — these are real URLs, so
          they navigate rather than setting `section`, and the server's SPA
          allowlist serves the shell for each one. */}
      <footer className="app-footer muted">
        <span>NORTHLINE</span>
        <a href="/support">Support</a>
        <a href="/terms">Terms of Service</a>
        <a href="/privacy">Privacy Policy</a>
        <a href="/refunds">Refunds &amp; cancellation</a>
      </footer>
    </main>
  );
}

function Root() {
  // An emailed link has to open its own screen even when this browser is
  // already signed in as somebody else. Without this the `session` branch
  // below simply won: `/accept-invitation` rendered the current user's
  // dashboard, so the invitation silently did nothing and looked broken.
  // Verification and password-reset links failed the same way.
  //
  // Held in state rather than derived on every render, because the pathname
  // never changes — these flows complete in place. Deriving it would keep
  // `Login` mounted for ever after a successful sign-in, since
  // `setAuthLink(false)` is what hands control back.
  const [authLink, setAuthLink] = useState(() =>
    isAuthLinkPath(window.location.pathname),
  );
  const [session, setSession] = useState<Session | null>(null);
  const [onboarding, setOnboarding] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    // `onboarding` has to be re-derived on every load, not just at sign-in:
    // refreshing halfway through the wizard must resume it rather than drop
    // the user on an empty dashboard.
    api<{ user: User; onboarding?: boolean }>("/auth/me")
      .then(({ user, onboarding }) => {
        setSession({ user, onboarding });
        setOnboarding(Boolean(onboarding));
      })
      .catch(() => setSession(null))
      .finally(() => setLoading(false));
  }, []);
  function login(next: Session) {
    // The emailed flow has run to completion, so release the override —
    // otherwise `Login` would keep rendering after a successful sign-in
    // because the path is still `/verify-email`.
    setAuthLink(false);
    // Release the pathname too. `Login` picks its form from the path
    // whenever it remounts, so leaving `/accept-invitation` in the address
    // bar made a later sign-out reopen the invitation form instead of the
    // sign-in form. The deep link has served its purpose by now.
    if (isAuthLinkPath(window.location.pathname))
      window.history.replaceState(null, "", "/");
    setSession(next);
    setOnboarding(Boolean(next.onboarding));
  }
  async function logout() {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    setSession(null);
  }
  if (loading) return <main className="loading-shell">Loading Northline…</main>;
  // `authLink` takes precedence over a live session on purpose: the form
  // owns the flow, and a successful accept/verify replaces the session.
  if (authLink || !session) return <Login onLogin={login} />;
  return onboarding ? (
    <Onboarding session={session} onDone={() => setOnboarding(false)} />
  ) : (
    <Workspace session={session} onLogout={logout} />
  );
}

/**
 * The legal surface must be reachable while signed out, and even while signed
 * in — so the pathname check sits *above* `Root` rather than inside it.
 * `Root` starts with `useState`/`useEffect`; returning before them would make
 * the number of hooks depend on the URL, which React forbids. This wrapper
 * holds no state, so the decision is a pure branch.
 */
function Router() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (isLegalPath(path)) return <Legal path={path} />;
  return <Root />;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Router />
  </React.StrictMode>,
);
