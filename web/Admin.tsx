import { useEffect, useState } from "react";
import { api } from "./api";
import type { AuditEntry, Invitation, Project, Role, User } from "./types";

export function Admin({
  users,
  audit,
  projects,
  token,
  onReload,
}: {
  users: User[];
  audit: AuditEntry[];
  projects: Project[];
  token?: string;
  onReload: () => void;
}) {
  const [selected, setSelected] = useState("");
  const [projectId, setProjectId] = useState("");
  const [role, setRole] = useState<Role>("worker");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("worker");
  const [inviteProject, setInviteProject] = useState("");
  const [message, setMessage] = useState("");
  const [invitations, setInvitations] = useState<Invitation[]>([]);

  async function loadInvitations() {
    try {
      const result = await api<{ invitations: Invitation[] }>(
        "/invitations",
        undefined,
        token,
      );
      setInvitations(result.invitations);
    } catch {
      setInvitations([]);
    }
  }

  useEffect(() => {
    void loadInvitations();
  }, []);

  async function invite() {
    try {
      await api(
        "/invitations",
        {
          method: "POST",
          body: JSON.stringify({
            email: inviteEmail,
            role: inviteRole,
            projectId: inviteProject || undefined,
          }),
        },
        token,
      );
      setInviteEmail("");
      setMessage(
        "Invitation sent. The teammate can use the secure email link.",
      );
      await loadInvitations();
      onReload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Invitation failed");
    }
  }

  async function invitationAction(
    invitation: Invitation,
    action: "resend" | "revoke",
  ) {
    try {
      await api(
        action === "resend"
          ? `/invitations/${invitation.id}/resend`
          : `/invitations/${invitation.id}`,
        { method: action === "resend" ? "POST" : "DELETE" },
        token,
      );
      setMessage(
        action === "resend" ? "Invitation resent." : "Invitation revoked.",
      );
      await loadInvitations();
    } catch (err) {
      setMessage(
        err instanceof Error ? err.message : "Invitation action failed",
      );
    }
  }

  async function assign() {
    try {
      await api(
        "/project-assignments",
        {
          method: "POST",
          body: JSON.stringify({
            userId: selected,
            projectId,
            roleInProject: role,
          }),
        },
        token,
      );
      setMessage("Assignment created");
      onReload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Assignment failed");
    }
  }

  return (
    <>
      <section className="panel">
        <h2>Invite a teammate</h2>
        <p className="muted">
          Invitations expire after 72 hours. Northline sends a secure one-time
          link; invitation tokens are never shown in production.
        </p>
        <div className="inline-form">
          <input
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
            placeholder="teammate@company.com"
            type="email"
          />
          <select
            value={inviteRole}
            onChange={(event) => setInviteRole(event.target.value as Role)}
          >
            <option value="worker">Worker</option>
            <option value="supervisor">Supervisor</option>
            <option value="accountant">Accountant</option>
          </select>
          <select
            value={inviteProject}
            onChange={(event) => setInviteProject(event.target.value)}
          >
            <option value="">No project yet</option>
            {projects.map((project) => (
              <option value={project.id} key={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <button onClick={invite} disabled={!inviteEmail}>
            Send invitation
          </button>
        </div>
        {message && <p className="muted">{message}</p>}
      </section>
      <section className="panel">
        <h2>Invitation status</h2>
        {invitations.length === 0 && (
          <p className="muted">No active or previous invitations.</p>
        )}
        {invitations.map((invitation) => {
          const pending =
            !invitation.acceptedAt &&
            !invitation.revokedAt &&
            new Date(invitation.expiresAt).getTime() > Date.now();
          return (
            <article className="row" key={invitation.id}>
              <span>
                {invitation.email} · {invitation.role}
                <br />
                <small className="muted">
                  Expires {new Date(invitation.expiresAt).toLocaleString()}
                </small>
              </span>
              <span>
                <span className={`status ${pending ? "active" : "muted"}`}>
                  {invitation.acceptedAt
                    ? "Accepted"
                    : invitation.revokedAt
                      ? "Revoked"
                      : pending
                        ? "Pending"
                        : "Expired"}
                </span>
                {pending && (
                  <>
                    <button
                      className="link-button"
                      onClick={() =>
                        void invitationAction(invitation, "resend")
                      }
                    >
                      Resend
                    </button>
                    <button
                      className="link-button"
                      onClick={() =>
                        void invitationAction(invitation, "revoke")
                      }
                    >
                      Revoke
                    </button>
                  </>
                )}
              </span>
            </article>
          );
        })}
      </section>
      <section className="panel">
        <h2>Project assignment</h2>
        <div className="inline-form">
          <select
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">Select user</option>
            {users
              .filter((user) => user.role !== "admin")
              .map((user) => (
                <option value={user.uuid} key={user.uuid}>
                  {user.name} · {user.role}
                </option>
              ))}
          </select>
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Select project</option>
            {projects.map((project) => (
              <option value={project.id} key={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <input
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
            placeholder="Role on project"
          />
          <button onClick={assign}>Assign</button>
        </div>
      </section>
      <section className="panel">
        <h2>Users</h2>
        {users.map((user) => (
          <article className="row" key={user.uuid}>
            <span>
              {user.name} · {user.email}
            </span>
            <span className="status active">{user.role}</span>
          </article>
        ))}
      </section>
      <section className="panel">
        <h2>Audit log</h2>
        {audit.map((entry, index) => (
          <article className="row" key={`${entry.at}-${index}`}>
            <span>
              {new Date(entry.at).toLocaleString()} · {entry.action}
            </span>
            <span>
              {entry.actorRole ?? "anonymous"} · {entry.status}
            </span>
          </article>
        ))}
      </section>
    </>
  );
}
