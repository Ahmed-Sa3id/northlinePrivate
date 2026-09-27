import type { Attendance, Issue, Project } from "./types";

export function Overview({
  projects,
  budget,
  actual,
  issues,
  attendance,
}: {
  projects: Project[];
  budget: number;
  actual: number;
  issues: Issue[];
  attendance: Attendance[];
}) {
  return (
    <>
      <div className="stats">
        <article>
          <span>Visible projects</span>
          <strong>{projects.length}</strong>
          <small>Assigned workspace sites</small>
        </article>
        <article>
          <span>Portfolio budget</span>
          <strong>${budget.toLocaleString()}</strong>
          <small>${actual.toLocaleString()} recorded spend</small>
        </article>
        <article>
          <span>Open safety issues</span>
          <strong>
            {issues.filter((issue) => issue.status !== "resolved").length}
          </strong>
          <small>{issues.length} total issues</small>
        </article>
        <article>
          <span>Attendance records</span>
          <strong>{attendance.length}</strong>
          <small>Role-visible activity</small>
        </article>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="kicker">Project portfolio</p>
            <h2>Active construction sites</h2>
          </div>
        </div>
        <div className="project-list">
          {projects.map((project) => (
            <article className="project" key={project.id}>
              <div>
                <strong>{project.name}</strong>
                <span>{project.location}</span>
              </div>
              <div>
                <span className={`status ${project.status}`}>
                  {project.status}
                </span>
                <strong>${Number(project.budget).toLocaleString()}</strong>
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
