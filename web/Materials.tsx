import { FormPanel, ProjectSelect } from "./FormPanel";
import type { Material, Project } from "./types";

export function Materials({
  data,
  projects,
  onSubmit,
}: {
  data: Material[];
  projects: Project[];
  onSubmit: (data: unknown) => void;
}) {
  return (
    <>
      <FormPanel
        title="Add material inventory"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          onSubmit({
            projectId: form.get("projectId"),
            name: form.get("name"),
            quantity: Number(form.get("quantity")),
            unit: form.get("unit"),
          });
        }}
      >
        <ProjectSelect projects={projects} />
        <input name="name" placeholder="Material name" required />
        <input
          name="quantity"
          type="number"
          min="0"
          step=".001"
          placeholder="Quantity"
          required
        />
        <input name="unit" placeholder="Unit (bags, m³, pcs)" required />
      </FormPanel>
      <section className="panel">
        <h2>Materials</h2>
        {data.map((row) => (
          <article className="row" key={row.id}>
            <span>
              <strong>{row.name}</strong> · {row.projectId}
            </span>
            <span>
              {row.quantity} {row.unit}
            </span>
          </article>
        ))}
      </section>
    </>
  );
}
