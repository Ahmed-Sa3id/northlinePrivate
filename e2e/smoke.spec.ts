import { expect, test } from "@playwright/test";

/**
 * Checks the E2E harness itself: the built bundle is served, the browser can
 * reach it, and the session probe resolved to "signed out". If this fails,
 * every journey spec would fail for the same reason and hide the real fault.
 */
test("serves the production shell and lands on the sign-in page", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".landing-nav .brand")).toHaveText("NORTHLINE");
  await expect(
    page.getByRole("button", { name: "Start free", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Enter your workspace." }),
  ).toBeVisible();
  // "Production" has to actually mean it. `import.meta.env.DEV` is baked in at
  // build time, and `vite build` only supplies a default `NODE_ENV` when the
  // variable is unset — CI's `test` and the webServer's `development` both
  // used to leak in, so the dev-only demo-credential hint shipped inside the
  // very bundle these specs exercise.
  await expect(page.getByText("Demo admin:")).toBeHidden();
});

test("resolves a legal deep link instead of returning 404", async ({
  page,
}) => {
  const response = await page.goto("/privacy");
  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Privacy Policy" }),
  ).toBeVisible();
});
