import React, { useState } from "react";
import { api } from "./api";
import type { Session } from "./types";

export function Onboarding({
  session,
  onDone,
}: {
  session: Session;
  onDone: () => void;
}) {
  const [step, setStep] = useState(1);
  const [project, setProject] = useState({
    name: "",
    location: "",
    budget: "",
    status: "planned",
  });
  const [invite, setInvite] = useState({
    name: "",
    email: "",
    password: "",
    role: "worker",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function createProject(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/onboarding/project", {
        method: "POST",
        body: JSON.stringify({ ...project, budget: Number(project.budget) }),
      });
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create project");
    } finally {
      setBusy(false);
    }
  }
  async function inviteMember(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (invite.email)
        await api("/users", { method: "POST", body: JSON.stringify(invite) });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add teammate");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="onboarding-shell">
      <div className="onboarding-card">
        <div className="brand">NORTHLINE</div>
        <p className="kicker">Workspace setup</p>
        <div className="stepper">
          <span className="active">1 Company</span>
          <span className={step >= 2 ? "active" : ""}>2 Project</span>
          <span className={step >= 3 ? "active" : ""}>3 Team</span>
        </div>
        {step === 1 && (
          <div>
            <h1>Your company is ready.</h1>
            <p className="muted">
              Welcome, {session.user.name ?? "owner"}. Let’s set up the first
              project your team will operate from.
            </p>
            <button onClick={() => setStep(2)}>Create first project</button>
          </div>
        )}
        {step === 2 && (
          <form onSubmit={createProject}>
            <h1>Add your first project.</h1>
            <label>
              Project name
              <input
                required
                value={project.name}
                onChange={(e) =>
                  setProject({ ...project, name: e.target.value })
                }
              />
            </label>
            <label>
              Location
              <input
                required
                value={project.location}
                onChange={(e) =>
                  setProject({ ...project, location: e.target.value })
                }
              />
            </label>
            <label>
              Budget
              <input
                required
                type="number"
                min="0"
                value={project.budget}
                onChange={(e) =>
                  setProject({ ...project, budget: e.target.value })
                }
              />
            </label>
            <label>
              Status
              <select
                value={project.status}
                onChange={(e) =>
                  setProject({ ...project, status: e.target.value })
                }
              >
                <option value="planned">Planned</option>
                <option value="active">Active</option>
              </select>
            </label>
            {error && <p className="error">{error}</p>}
            <button disabled={busy}>{busy ? "Saving…" : "Continue"}</button>
          </form>
        )}
        {step === 3 && (
          <form onSubmit={inviteMember}>
            <h1>Invite your first teammate.</h1>
            <p className="muted">
              You can skip this and invite people later from Admin.
            </p>
            <label>
              Name
              <input
                value={invite.name}
                onChange={(e) => setInvite({ ...invite, name: e.target.value })}
              />
            </label>
            <label>
              Email
              <input
                type="email"
                value={invite.email}
                onChange={(e) =>
                  setInvite({ ...invite, email: e.target.value })
                }
              />
            </label>
            <label>
              Temporary password
              <input
                minLength={8}
                type="password"
                value={invite.password}
                onChange={(e) =>
                  setInvite({ ...invite, password: e.target.value })
                }
              />
            </label>
            <label>
              Role
              <select
                value={invite.role}
                onChange={(e) => setInvite({ ...invite, role: e.target.value })}
              >
                <option value="worker">Worker</option>
                <option value="supervisor">Supervisor</option>
                <option value="accountant">Accountant</option>
              </select>
            </label>
            {error && <p className="error">{error}</p>}
            <button disabled={busy}>
              {busy
                ? "Saving…"
                : invite.email
                  ? "Add teammate and open dashboard"
                  : "Skip to dashboard"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
