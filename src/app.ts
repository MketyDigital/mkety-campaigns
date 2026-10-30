import { Hono } from "hono";

export const app = new Hono();

app.get("/", (context) =>
  context.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mkety Campaigns</title>
  </head>
  <body>
    <main>
      <h1>Mkety Campaigns</h1>
      <p>Standalone campaign portal. Sign-in and campaign features are being set up.</p>
    </main>
  </body>
</html>`),
);

app.get("/healthz", (context) => context.json({ status: "ok" }));
