import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * `dist/web/index.html` is a build artefact, and the SPA shell routes read
 * it. The suite must not depend on whether `pnpm build` has happened to run,
 * so a missing shell is materialised from the source `web/index.html` and
 * removed again afterwards — the handler under test is the routing, not the
 * bundle.
 *
 * Returns the cleanup to run from `afterAll`. When the shell already exists
 * (because the build ran first) the no-op keeps CI's order untouched.
 */
export function ensureSpaShell(): () => void {
  const shellPath = path.resolve("dist/web/index.html");
  const sourceShellPath = path.resolve("web/index.html");
  if (existsSync(shellPath)) return () => undefined;
  mkdirSync(path.dirname(shellPath), { recursive: true });
  copyFileSync(sourceShellPath, shellPath);
  return () => rmSync(shellPath, { force: true });
}
