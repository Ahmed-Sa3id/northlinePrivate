import { useState } from "react";
import type { Project } from "./types";

export function ProjectForm({
  onSubmit,
}: {
  onSubmit: (data: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [budget, setBudget] = useState("");
  if (!open)
    return <button onClick={() => setOpen(true)}>+ New project</button>;
  return (
    <form
      className="inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ name, location, budget: Number(budget), status: "planned" });
        setOpen(false);
      }}
    >
      <input
        placeholder="Project name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />
      <input
        placeholder="Location"
        value={location}
        onChange={(event) => setLocation(event.target.value)}
        required
      />
      <input
        placeholder="Budget"
        type="number"
        value={budget}
        onChange={(event) => setBudget(event.target.value)}
        required
      />
      <button>Create</button>
    </form>
  );
}

export function Projects({
  projects,
  canEdit,
  onDelete,
  onUpdate,
}: {
  projects: Project[];
  canEdit: boolean;
  onDelete: (id: string) => void;
  onUpdate: (id: string, status: string) => void;
}) {
  return (
    <section className="panel">
      <div className="project-list">
        {projects.map((project) => (
          <article className="project" key={project.id}>
            <div>
              <strong>{project.name}</strong>
              <span>
                {project.location} · ${Number(project.budget).toLocaleString()}
              </span>
            </div>
            <div>
              <select
                value={project.status}
                disabled={!canEdit}
                onChange={(event) => onUpdate(project.id, event.target.value)}
              >
                <option>planned</option>
                <option>active</option>
                <option>paused</option>
                <option>completed</option>
              </select>
              {canEdit && (
                <button className="danger" onClick={() => onDelete(project.id)}>
                  Delete
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
