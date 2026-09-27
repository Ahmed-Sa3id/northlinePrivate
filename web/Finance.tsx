import { FormPanel, ProjectSelect } from "./FormPanel";
import type { Expense, Project } from "./types";

export function Finance({
  data,
  projects,
  onSubmit,
}: {
  data: Expense[];
  projects: Project[];
  onSubmit: (data: unknown) => void;
}) {
  const actualByProject = data.reduce<Record<string, number>>(
    (totals, expense) => {
      totals[expense.projectId] =
        (totals[expense.projectId] ?? 0) + Number(expense.amount);
      return totals;
    },
    {},
  );

  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="kicker">Budget control</p>
            <h2>Budget versus actual</h2>
          </div>
          <span className="muted">
            Same-day visibility into project overruns
          </span>
        </div>
        <div className="project-list">
          {projects.map((project) => {
            const actual = actualByProject[project.id] ?? 0;
            const budget = Number(project.budget);
            const variance = budget - actual;
            const overBudget = variance < 0;
            return (
              <article className="project" key={project.id}>
                <div>
                  <strong>{project.name}</strong>
                  <span>
                    {project.location} · {project.status}
                  </span>
                </div>
                <div>
                  <strong>
                    ${actual.toLocaleString()} / ${budget.toLocaleString()}
                  </strong>
                  <span className={`status ${overBudget ? "high" : "active"}`}>
                    {overBudget
                      ? `Over by $${Math.abs(variance).toLocaleString()}`
                      : `$${variance.toLocaleString()} remaining`}
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      </section>
      <FormPanel
        title="Record expense"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          onSubmit({
            projectId: form.get("projectId"),
            category: form.get("category"),
            amount: Number(form.get("amount")),
            expDate: form.get("expDate"),
          });
        }}
      >
        <ProjectSelect projects={projects} />
        <input name="category" placeholder="Category" required />
        <input
          name="amount"
          type="number"
          min="0"
          step=".01"
          placeholder="Amount"
          required
        />
        <input
          name="expDate"
          type="date"
          required
          defaultValue={new Date().toISOString().slice(0, 10)}
        />
      </FormPanel>
      <section className="panel">
        <h2>Expenses</h2>
        {data.map((row) => (
          <article className="row" key={row.id}>
            <span>
              {row.category} · {row.expDate.slice(0, 10)}
            </span>
            <strong>${Number(row.amount).toLocaleString()}</strong>
          </article>
        ))}
      </section>
    </>
  );
}
