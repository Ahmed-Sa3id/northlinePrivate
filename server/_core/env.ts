export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
};

export function assertProductionConfiguration() {
  if (!ENV.isProduction) return;
  const required: Array<[string, string]> = [
    ["DATABASE_URL", ENV.databaseUrl],
    ["JWT_SECRET", ENV.cookieSecret],
    ["ALLOWED_ORIGINS", process.env.ALLOWED_ORIGINS ?? ""],
    ["APP_URL", process.env.APP_URL ?? ""],
    ["EMAIL_FROM", process.env.EMAIL_FROM ?? ""],
    ["RESEND_API_KEY", process.env.RESEND_API_KEY ?? ""],
    ["STORAGE_BACKEND", process.env.STORAGE_BACKEND ?? ""],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (ENV.cookieSecret.length < 32) missing.push("JWT_SECRET(32+ characters)");
  if (process.env.STORAGE_BACKEND !== "s3") missing.push("STORAGE_BACKEND=s3");
  if (
    (process.env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .some((origin) => origin.trim() === "*")
  )
    missing.push("ALLOWED_ORIGINS must not contain *");
  // Every verification, reset and invitation link is built from APP_URL, so
  // an unset or non-HTTPS value would email links pointing at localhost.
  const appUrl = (process.env.APP_URL ?? "").trim();
  if (appUrl) {
    try {
      if (new URL(appUrl).protocol !== "https:")
        missing.push("APP_URL must use HTTPS");
    } catch {
      missing.push("APP_URL must be a valid URL");
    }
  }
  if (missing.length)
    throw new Error(`Missing production configuration: ${missing.join(", ")}`);
}
