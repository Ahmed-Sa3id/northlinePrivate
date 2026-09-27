import { FormPanel, ProjectSelect } from "./FormPanel";
import type { Attendance as AttendanceRecord, Project, User } from "./types";

export function Attendance({
  data,
  projects,
  user,
  onSubmit,
  onCheckout,
}: {
  data: AttendanceRecord[];
  projects: Project[];
  user: User;
  onSubmit: (data: unknown) => void;
  onCheckout: (id: string) => void;
}) {
  return (
    <>
      <FormPanel
        title="Log attendance"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          onSubmit({
            projectId: form.get("projectId"),
            userId: user.role === "worker" ? undefined : form.get("userId"),
            workDate: form.get("workDate"),
            checkIn: new Date().toISOString(),
          });
        }}
      >
        <ProjectSelect projects={projects} />
        <input
          name="workDate"
          type="date"
          required
          defaultValue={new Date().toISOString().slice(0, 10)}
        />
      </FormPanel>
      <section className="panel">
        <h2>Attendance log</h2>
        {data.map((row) => (
          <article className="row" key={row.id}>
            <span>
              {row.workDate.slice(0, 10)} ·{" "}
              {row.userName ?? row.userEmail ?? "Unknown worker"}
              <small>{row.projectName}</small>
            </span>
            <span>
              {row.checkIn
                ? new Date(row.checkIn).toLocaleTimeString()
                : "Not checked in"}
              {row.checkOut ? (
                ` → ${new Date(row.checkOut).toLocaleTimeString()}`
              ) : (
                <button className="small" onClick={() => onCheckout(row.id)}>
                  Check out
                </button>
              )}
            </span>
          </article>
        ))}
      </section>
    </>
  );
}
