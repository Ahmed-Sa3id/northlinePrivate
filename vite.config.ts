import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => {
  // A build is always a production build — ambient `NODE_ENV` must not be
  // able to degrade it.
  //
  // `resolveConfig` captures `isNodeEnvSet` at the top of the function, before
  // this file is even loaded, and then only assigns a default when the
  // variable was *unset*. Whatever the shell exported therefore wins. Two
  // real callers were exporting something else: CI sets `NODE_ENV: test` for
  // the whole job, and the Playwright webServer sets `NODE_ENV: development`
  // for `pnpm e2e:server` because the server process itself needs it. Both
  // leaked into `vite build`, so `import.meta.env.DEV` stayed `true` and the
  // dev-only demo-credential hint was dead code that never got eliminated —
  // it shipped inside the very bundle the browser tests then exercised.
  //
  // Set here rather than as a `NODE_ENV=production` prefix on the script,
  // which only works in POSIX shells and would break `pnpm build` on Windows.
  if (command === "build") process.env.NODE_ENV = "production";

  return {
    root: "web",
    plugins: [react()],
    build: { outDir: "../dist/web", emptyOutDir: true },
    server: { host: "0.0.0.0", port: 5173 },
  };
});
