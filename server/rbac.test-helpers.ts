import request from "supertest";
import { expect } from "vitest";
import { app } from "./index";

export async function session(email: string, password: string) {
  const response = await request(app)
    .post("/auth/login")
    .send({ email, password });
  expect(response.status).toBe(200);
  const cookie = response.headers["set-cookie"]?.[0];
  expect(cookie).toContain("northline_session=");
  return cookie.split(";")[0];
}

export { app, request };
