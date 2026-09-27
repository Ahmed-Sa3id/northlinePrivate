export type Role = "admin" | "supervisor" | "worker" | "accountant";
export type User = {
  uuid: string;
  companyId: string;
  name: string | null;
  email: string | null;
  role: Role;
};
export type Project = {
  id: string;
  name: string;
  location: string;
  status: string;
  budget: string;
};
export type Attendance = {
  id: string;
  userId: string;
  projectId: string;
  workDate: string;
  checkIn: string | null;
  checkOut: string | null;
  userName: string | null;
  userEmail: string | null;
  projectName: string;
};
export type Material = {
  id: string;
  projectId: string;
  name: string;
  quantity: string;
  unit: string;
};
export type Expense = {
  id: string;
  projectId: string;
  category: string;
  amount: string;
  expDate: string;
};
export type Issue = {
  id: string;
  projectId: string;
  description: string;
  severity: string;
  status: string;
  createdAt: string;
  imageUrl: string | null;
};
export type AuditEntry = {
  actorId: string | null;
  actorRole: string | null;
  action: string;
  status: number;
  at: string;
};
export type Invitation = {
  id: string;
  email: string;
  role: Role;
  projectId: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};
export type Company = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
};
export type Session = { token?: string; user: User; onboarding?: boolean };
export type SubscriptionResponse = {
  subscription: {
    id: string;
    planId: string;
    status: string;
    trialStartsAt: string | null;
    trialEndsAt: string | null;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    canceledAt: string | null;
  };
  plan: {
    id: string;
    name: string;
    price: string;
    billingInterval: string;
    maxUsers: number | null;
    maxProjects: number | null;
    features: string;
  };
};
