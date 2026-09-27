import { ENV } from "./env";

/**
 * Whether the demo fixtures are allowed in this environment.
 *
 * `seed.ts` creates four fixture accounts whose passwords are published in
 * README.md (they are what the integration suite authenticates as). That is
 * correct in development and CI, but installing them into a production
 * database would mean a publicly-known admin login on a real deployment —
 * and DEPLOY.md used to instruct operators to run exactly that seed.
 *
 * So: allowed everywhere except production, unless the operator opts in with
 * SEED_DEMO_USERS=1 for a deliberate non-production demonstration.
 *
 * Lives in its own module so both seed scripts can import it without either
 * importing the other (importing `seed.ts` would execute its main()).
 */
export const demoFixturesAllowed =
  !ENV.isProduction || process.env.SEED_DEMO_USERS === "1";
