import { Hono } from "hono";

export type AppBindings = {
  Bindings: {
    DB?: D1Database;
    DATABASE_URL?: string;
  };
  Variables: {
    databaseReady: () => Promise<boolean>;
  };
};

export function createApp(checkDatabase: () => Promise<boolean> = async () => false) {
  const app = new Hono<AppBindings>();

  app.use("*", async (c, next) => {
    c.set("databaseReady", checkDatabase);
    await next();
  });

  app.get("/", (c) => c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#006fff" />
    <title>MKETY Campaigns</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #10233f; background: #f5f8fc; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; }
      header { height: 68px; display: flex; align-items: center; padding: 0 max(24px, calc((100vw - 1120px) / 2)); background: #fff; border-bottom: 1px solid #e5ebf3; }
      .brand { display: flex; align-items: center; gap: 11px; font-weight: 750; letter-spacing: -.02em; }
      .mark { width: 31px; height: 31px; display: grid; place-items: center; border-radius: 9px; background: #006fff; color: white; font-size: 14px; }
      main { width: min(1120px, calc(100% - 40px)); margin: 58px auto; }
      .eyebrow { color: #006fff; font-size: 12px; text-transform: uppercase; letter-spacing: .13em; font-weight: 750; }
      h1 { margin: 10px 0 8px; font-size: clamp(30px, 5vw, 42px); letter-spacing: -.04em; }
      .intro { color: #60728b; max-width: 600px; line-height: 1.65; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-top: 36px; }
      .card { background: white; border: 1px solid #e4eaf2; border-radius: 14px; padding: 20px; box-shadow: 0 5px 18px #163d6a08; }
      .card h2 { margin: 0 0 8px; font-size: 15px; }
      .card p { margin: 0; color: #6a7b91; font-size: 13px; line-height: 1.55; }
      .status { display: inline-flex; align-items: center; gap: 7px; color: #277650; font-size: 12px; font-weight: 700; }
      .dot { width: 7px; height: 7px; background: #32a46b; border-radius: 50%; }
      footer { margin-top: 32px; color: #8795a8; font-size: 12px; }
    </style>
  </head>
  <body>
    <header><div class="brand"><span class="mark">M</span><span>MKETY Campaigns</span></div></header>
    <main>
      <div class="eyebrow">Standalone campaign platform</div>
      <h1>Your campaign workspace is starting here.</h1>
      <p class="intro">A focused workspace for consent-aware email and SMS campaigns, with isolated tenant data and controlled delivery.</p>
      <div class="grid">
        <section class="card"><h2>Campaigns</h2><p>Drafts, approvals, schedules, and delivery controls are being built.</p></section>
        <section class="card"><h2>Storage</h2><p>R2 is the primary object store. OCI archive and Azure backup are independent targets.</p></section>
        <section class="card"><h2>Delivery safety</h2><p>Sending stays disabled until provider, domain, and compliance checks are approved.</p></section>
      </div>
      <footer>MKETY Campaigns is independent from MKETY Mail and other MKETY systems.</footer>
    </main>
  </body>
</html>`));

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", async (c) => {
    const ready = await c.get("databaseReady")();
    return c.json({ status: ready ? "ready" : "not_ready" }, ready ? 200 : 503);
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}
