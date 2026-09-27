import { FormPanel, ProjectSelect } from "./FormPanel";
import type { Issue, Project } from "./types";

export function Issues({
  data,
  projects,
  onSubmit,
}: {
  data: Issue[];
  projects: Project[];
  onSubmit: (data: FormData) => void;
}) {
  return (
    <>
      <FormPanel
        title="Report safety issue"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(new FormData(event.currentTarget));
        }}
      >
        <ProjectSelect projects={projects} />
        <textarea
          name="description"
          placeholder="Describe the issue"
          minLength={5}
          required
        />
        <select name="severity">
          <option>low</option>
          <option>medium</option>
          <option>high</option>
        </select>
        <input name="image" type="file" accept="image/*" />
      </FormPanel>
      <section className="panel">
        <h2>Safety issues</h2>
        {data.map((row) => (
          <article className="row" key={row.id}>
            <span>
              <strong>{row.severity}</strong> · {row.description}
            </span>
            <span className={`status ${row.status}`}>{row.status}</span>
          </article>
        ))}
      </section>
    </>
  );
}
