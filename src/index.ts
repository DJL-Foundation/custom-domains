import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { z } from "zod";

const post_domains = z.object({
  customDomain: z.string(),
  targetAppUrl: z.url(),
});

const delete_domains = z.object({
  customDomain: z.string(),
});

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.use("/api/*", async (c, next) => {
  console.log(c.env.ACCESS_TOKEN);
  const auth = bearerAuth({
    token: c.env.ACCESS_TOKEN,
  });
  return auth(c, next);
});

app.post("/api/domains", async (c) => {
  const body = await c.req.json();
  const parsed = post_domains.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }
  const { customDomain, targetAppUrl } = parsed.data;
  await c.env["hostnames-kv"].put(customDomain, targetAppUrl);
  return c.json({ message: "Domain added successfully" });
});

app.delete("/api/domains", async (c) => {
  const body = await c.req.json();
  const parsed = delete_domains.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }
  const { customDomain } = parsed.data;
  await c.env["hostnames-kv"].delete(customDomain);
  return c.json({ message: "Domain deleted successfully" });
});

app.all("*", async (c) => {
  const host = c.req.header("Host");
  if (!host) {
    return c.json({ error: "Host header is required" }, 400);
  }

  const targetAppUrl = await c.env["hostnames-kv"].get(host);
  if (!targetAppUrl) {
    return c.json(
      { error: "Domain not configured correctly or not found" },
      404,
    );
  }

  const url = new URL(c.req.url);
  const proxyUrl = new URL(url.pathname + url.search, targetAppUrl);

  const proxyReq = new Request(proxyUrl.toString(), c.req.raw);
  proxyReq.headers.set("x-forwarded-host", host);

  return fetch(proxyReq);
});

export default app;
