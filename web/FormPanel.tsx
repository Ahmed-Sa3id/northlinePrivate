import type React from "react";
import type { Project } from "./types";

export function FormPanel({
  children,
  onSubmit,
  title,
}: {
  children: React.ReactNode;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  title: string;
}) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      <form className="data-form" onSubmit={onSubmit}>
        {children}
        <button>Save record</button>
      </form>
    </section>
  );
}

export function ProjectSelect({ projects }: { projects: Project[] }) {
  return (
    <select name="projectId" required>
      <option value="">Select project</option>
      {projects.map((project) => (
        <option value={project.id} key={project.id}>
          {project.name}
        </option>
      ))}
    </select>
  );
}
