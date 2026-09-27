import { relations } from "drizzle-orm";
import {
  attendance,
  expenses,
  issues,
  materialTransactions,
  materials,
  projectAssignments,
  projects,
  users,
} from "./schema";

export const usersRelations = relations(users, ({ many }) => ({
  assignments: many(projectAssignments),
  attendance: many(attendance),
  materialTransactions: many(materialTransactions),
  expenses: many(expenses),
  issues: many(issues),
}));

export const projectsRelations = relations(projects, ({ many }) => ({
  assignments: many(projectAssignments),
  attendance: many(attendance),
  materials: many(materials),
  expenses: many(expenses),
  issues: many(issues),
}));

export const projectAssignmentsRelations = relations(
  projectAssignments,
  ({ one }) => ({
    user: one(users, {
      fields: [projectAssignments.userId],
      references: [users.uuid],
    }),
    project: one(projects, {
      fields: [projectAssignments.projectId],
      references: [projects.id],
    }),
  }),
);

export const attendanceRelations = relations(attendance, ({ one }) => ({
  user: one(users, { fields: [attendance.userId], references: [users.uuid] }),
  project: one(projects, {
    fields: [attendance.projectId],
    references: [projects.id],
  }),
}));

export const materialsRelations = relations(materials, ({ one, many }) => ({
  project: one(projects, {
    fields: [materials.projectId],
    references: [projects.id],
  }),
  transactions: many(materialTransactions),
}));

export const materialTransactionsRelations = relations(
  materialTransactions,
  ({ one }) => ({
    material: one(materials, {
      fields: [materialTransactions.materialId],
      references: [materials.id],
    }),
    recordedByUser: one(users, {
      fields: [materialTransactions.recordedBy],
      references: [users.uuid],
    }),
  }),
);

export const expensesRelations = relations(expenses, ({ one }) => ({
  project: one(projects, {
    fields: [expenses.projectId],
    references: [projects.id],
  }),
  recordedByUser: one(users, {
    fields: [expenses.recordedBy],
    references: [users.uuid],
  }),
}));

export const issuesRelations = relations(issues, ({ one }) => ({
  project: one(projects, {
    fields: [issues.projectId],
    references: [projects.id],
  }),
  reportedByUser: one(users, {
    fields: [issues.reportedBy],
    references: [users.uuid],
  }),
}));
