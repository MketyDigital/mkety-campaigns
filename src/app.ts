import { Hono } from "hono";
import { DomainConflictError, DomainProvisioningError, DomainRetryNotAvailableError, type TenantDomainService } from "./domains/service.js";
import type { VerificationType } from "./domains/azure-arm.js";

export type AppBindings = {
  Bindings: {
    DB?: D1Database;
    DATABASE_URL?: string;
  };
  Variables: {
    databaseReady: () => Promise<boolean>;
    tenantContext: { tenantId: string; userId: string };
  };
};

export type AuthSession = {
  user: { id: string; role?: string; twoFactorEnabled?: boolean };
  session: { createdAt: Date | string };
};

export type AppSecurity = {
  auth: {
    handler(request: Request): Response | Promise<Response>;
    getSession(headers: Headers): Promise<AuthSession | null>;
  };
  resolveTenantSeat(userId: string, sessionCreatedAt: Date): Promise<string | null>;
};

export function createApp(
  checkDatabase: () => Promise<boolean> = async () => false,
  security?: AppSecurity,
  domains?: TenantDomainService,
) {
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

  app.get("/app/domains", (c) => c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#006fff" />
    <title>Sender domains · MKETY Campaigns</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #10233f; background: #f5f8fc; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; }
      header { height: 68px; display: flex; align-items: center; padding: 0 max(24px, calc((100vw - 1000px) / 2)); background: #fff; border-bottom: 1px solid #e5ebf3; }
      .brand { display: flex; align-items: center; gap: 11px; font-weight: 750; letter-spacing: -.02em; color: inherit; text-decoration: none; }
      .mark { width: 31px; height: 31px; display: grid; place-items: center; border-radius: 9px; background: #006fff; color: white; font-size: 14px; }
      main { width: min(1000px, calc(100% - 40px)); margin: 46px auto; }
      .eyebrow { color: #006fff; font-size: 12px; text-transform: uppercase; letter-spacing: .13em; font-weight: 750; }
      h1 { margin: 10px 0 8px; font-size: clamp(28px, 5vw, 38px); letter-spacing: -.04em; }
      .intro { color: #60728b; max-width: 680px; line-height: 1.65; }
      .panel { margin-top: 26px; padding: 22px; background: white; border: 1px solid #e4eaf2; border-radius: 14px; box-shadow: 0 5px 18px #163d6a08; }
      .form { display: flex; gap: 10px; margin-top: 16px; }
      input { min-width: 0; flex: 1; padding: 12px; border: 1px solid #cbd6e4; border-radius: 8px; font: inherit; }
      button { border: 0; border-radius: 8px; padding: 11px 15px; background: #006fff; color: white; font: inherit; font-weight: 700; cursor: pointer; }
      button.secondary { background: #edf4ff; color: #1254a4; }
      button:disabled { cursor: wait; opacity: .6; }
      .hint, .muted { color: #6a7b91; font-size: 13px; line-height: 1.55; }
      #notice { min-height: 20px; margin: 14px 0 0; font-size: 13px; color: #9a3b23; }
      .domain { margin-top: 14px; padding: 20px; background: white; border: 1px solid #e4eaf2; border-radius: 14px; }
      .domain-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
      h2 { margin: 0; font-size: 18px; overflow-wrap: anywhere; }
      .status { color: #60728b; font-size: 12px; margin-top: 6px; }
      .badge { display: inline-block; padding: 5px 8px; border-radius: 99px; background: #edf4ff; color: #1254a4; font-size: 11px; font-weight: 700; white-space: nowrap; }
      .records { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 12px; }
      .records th, .records td { padding: 10px 8px; border-top: 1px solid #e8edf4; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
      .records th { color: #6a7b91; font-weight: 650; }
      .record-value { max-width: 360px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
      .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
      .empty { padding: 24px 0 4px; color: #6a7b91; font-size: 13px; }
      @media (max-width: 620px) { .form { flex-direction: column; } .domain-head { flex-direction: column; } .records { display: block; overflow-x: auto; } }
    </style>
  </head>
  <body>
    <header><a class="brand" href="/"><span class="mark">M</span><span>MKETY Campaigns</span></a></header>
    <main>
      <div class="eyebrow">Workspace setup</div>
      <h1>Sender domains</h1>
      <p class="intro">Add a domain you own, publish the DNS records shown below, then refresh verification. A dedicated sending subdomain such as <strong>mail.example.com</strong> is a good starting point.</p>
      <section class="panel">
        <h2>Add a sender domain</h2>
        <p class="hint">Use a domain or subdomain you control. Email sending stays disabled until Azure verifies the records and links the domain.</p>
        <form class="form" id="add-domain">
          <input id="domain-name" name="domainName" type="text" placeholder="mail.example.com" autocomplete="off" required aria-label="Domain name" />
          <button type="submit">Add domain</button>
        </form>
        <p id="notice" role="status" aria-live="polite"></p>
      </section>
      <section id="domain-list" aria-live="polite"><p class="empty">Loading sender domains…</p></section>
    </main>
    <script>
      const list = document.getElementById('domain-list');
      const notice = document.getElementById('notice');
      const api = '/api/tenant/domains';
      async function request(path, options) {
        const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'content-type': 'application/json', ...(options && options.headers || {}) } });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'Request failed');
        return payload;
      }
      function label(value) {
        return String(value || '').replace(/_/g, ' ');
      }
      function render(domains) {
        list.replaceChildren();
        if (!domains.length) {
          const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No sender domains yet.'; list.append(empty); return;
        }
        for (const domain of domains) {
          const card = document.createElement('article'); card.className = 'domain';
          const head = document.createElement('div'); head.className = 'domain-head';
          const details = document.createElement('div');
          const title = document.createElement('h2'); title.textContent = domain.domainName;
          const state = document.createElement('p'); state.className = 'status'; state.textContent = 'Provisioning: ' + label(domain.provisioningState);
          details.append(title, state);
          const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = domain.linked ? 'Linked and verified' : 'DNS setup required';
          head.append(details, badge); card.append(head);
          const entries = Object.entries(domain.verificationRecords || {});
          if (!entries.length) {
            const note = document.createElement('p'); note.className = 'muted'; note.textContent = 'Azure is preparing the DNS records. Refresh in a moment.'; card.append(note);
          } else {
            const table = document.createElement('table'); table.className = 'records';
            const thead = document.createElement('thead'); const header = document.createElement('tr');
            for (const text of ['DNS records', 'Type', 'Name', 'Value', 'Status']) { const th = document.createElement('th'); th.textContent = text; header.append(th); }
            thead.append(header); table.append(thead);
            const tbody = document.createElement('tbody');
            for (const [type, record] of entries) {
              const row = document.createElement('tr');
              for (const value of [type, record.type, record.name, record.value, (domain.verificationStates || {})[type]?.status || 'Not started']) {
                const td = document.createElement('td'); if (value === record.value) td.className = 'record-value'; td.textContent = String(value || '—'); row.append(td);
              }
              tbody.append(row);
            }
            table.append(tbody); card.append(table);
          }
          const actions = document.createElement('div'); actions.className = 'actions';
          if (domain.provisioningState === 'Failed') {
            const retry = document.createElement('button'); retry.textContent = 'Retry provisioning'; retry.addEventListener('click', () => runAction(domain.id, 'retry'));
            actions.append(retry);
          }
          const refresh = document.createElement('button'); refresh.className = 'secondary'; refresh.textContent = 'Refresh DNS status'; refresh.addEventListener('click', () => runAction(domain.id, 'refresh'));
          actions.append(refresh);
          for (const [type] of entries) {
            if ((domain.verificationStates || {})[type]?.status === 'Verified') continue;
            const verify = document.createElement('button'); verify.className = 'secondary'; verify.textContent = 'Check ' + type;
            verify.addEventListener('click', () => runAction(domain.id, 'verify', { type })); actions.append(verify);
          }
          card.append(actions); list.append(card);
        }
      }
      async function load() {
        try { const result = await request(api); render(result.domains || []); }
        catch (error) { list.replaceChildren(); const message = document.createElement('p'); message.className = 'empty'; message.textContent = error.message === 'unauthorized' ? 'Sign in to manage sender domains.' : error.message === 'auth_not_configured' ? 'Portal authentication is not configured yet.' : 'Could not load domains. Please try again.'; list.append(message); }
      }
      async function runAction(id, action, body) {
        notice.textContent = '';
        try { await request(api + '/' + encodeURIComponent(id) + '/' + action, { method: 'POST', body: body ? JSON.stringify(body) : '{}' }); await load(); }
        catch (error) { notice.textContent = error.message === 'domain_provider_failed' ? 'The email provider could not complete this step. Check the provider configuration and try again.' : 'Action failed. Please try again.'; }
      }
      document.getElementById('add-domain').addEventListener('submit', async (event) => {
        event.preventDefault(); notice.textContent = '';
        const button = event.currentTarget.querySelector('button'); button.disabled = true;
        try { await request(api, { method: 'POST', body: JSON.stringify({ domainName: document.getElementById('domain-name').value }) }); document.getElementById('domain-name').value = ''; await load(); }
        catch (error) { notice.textContent = error.message === 'domain_already_registered' ? 'That domain is already registered.' : error.message === 'domain_name_invalid' ? 'Enter a valid domain or subdomain.' : error.message === 'domain_provider_failed' ? 'Azure could not create this domain. Check the Azure setup and try again.' : 'Could not add the domain. Please try again.'; }
        finally { button.disabled = false; }
      });
      load();
    </script>
  </body>
</html>`));

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", async (c) => {
    const ready = await c.get("databaseReady")();
    return c.json({ status: ready ? "ready" : "not_ready" }, ready ? 200 : 503);
  });

  app.all("/api/auth/*", (c) => security
    ? security.auth.handler(c.req.raw)
    : c.json({ error: "auth_not_configured" }, 503));

  app.use("/api/tenant/*", async (c, next) => {
    if (!security) return c.json({ error: "auth_not_configured" }, 503);
    const session = await security.auth.getSession(c.req.raw.headers);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    if (!session.user.twoFactorEnabled) return c.json({ error: "mfa_required" }, 403);
    const sessionCreatedAt = new Date(session.session.createdAt);
    if (Number.isNaN(sessionCreatedAt.getTime())) return c.json({ error: "mfa_required" }, 403);
    const tenantId = await security.resolveTenantSeat(session.user.id, sessionCreatedAt);
    if (!tenantId) return c.json({ error: "active_tenant_seat_required" }, 403);
    c.set("tenantContext", { tenantId, userId: session.user.id });
    await next();
  });

  app.get("/api/tenant/me", (c) => {
    const scope = c.get("tenantContext");
    return c.json({ tenantId: scope.tenantId, userId: scope.userId });
  });

  app.get("/api/tenant/domains", async (c) => {
    if (!domains) return c.json({ error: "domain_management_not_configured" }, 503);
    try {
      return c.json({ domains: await domains.list(c.get("tenantContext").tenantId) });
    } catch {
      return c.json({ error: "domain_operation_failed" }, 500);
    }
  });

  app.post("/api/tenant/domains", async (c) => {
    if (!domains) return c.json({ error: "domain_management_not_configured" }, 503);
    const payload = await c.req.json().catch(() => null) as { domainName?: unknown } | null;
    if (!payload || typeof payload.domainName !== "string") return c.json({ error: "domain_name_required" }, 400);
    try {
      const domain = await domains.create(c.get("tenantContext").tenantId, payload.domainName);
      return c.json({ domain }, 201);
    } catch (error) {
      return domainErrorResponse(c, error);
    }
  });

  app.post("/api/tenant/domains/:id/refresh", async (c) => {
    if (!domains) return c.json({ error: "domain_management_not_configured" }, 503);
    try {
      const domain = await domains.refresh(c.get("tenantContext").tenantId, c.req.param("id"));
      return domain ? c.json({ domain }) : c.json({ error: "domain_not_found" }, 404);
    } catch (error) {
      return domainErrorResponse(c, error);
    }
  });

  app.post("/api/tenant/domains/:id/retry", async (c) => {
    if (!domains) return c.json({ error: "domain_management_not_configured" }, 503);
    try {
      const domain = await domains.retryCreate(c.get("tenantContext").tenantId, c.req.param("id"));
      return domain ? c.json({ domain }) : c.json({ error: "domain_not_found" }, 404);
    } catch (error) {
      return domainErrorResponse(c, error);
    }
  });

  app.post("/api/tenant/domains/:id/verify", async (c) => {
    if (!domains) return c.json({ error: "domain_management_not_configured" }, 503);
    const payload = await c.req.json().catch(() => null) as { type?: unknown } | null;
    const verificationTypes: VerificationType[] = ["Domain", "SPF", "DKIM", "DKIM2", "DMARC"];
    if (!payload || typeof payload.type !== "string" || !verificationTypes.includes(payload.type as VerificationType)) {
      return c.json({ error: "verification_type_invalid" }, 400);
    }
    try {
      const domain = await domains.verify(c.get("tenantContext").tenantId, c.req.param("id"), payload.type as VerificationType);
      return domain ? c.json({ domain }) : c.json({ error: "domain_not_found" }, 404);
    } catch (error) {
      return domainErrorResponse(c, error);
    }
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}

function domainErrorResponse(c: { json: (value: unknown, status?: number) => Response }, error: unknown): Response {
  if (error instanceof DomainConflictError) return c.json({ error: "domain_already_registered" }, 409);
  if (error instanceof DomainProvisioningError) return c.json({ error: "domain_provider_failed" }, 502);
  if (error instanceof DomainRetryNotAvailableError) return c.json({ error: "domain_retry_not_available" }, 409);
  if (error instanceof Error && /valid domain name/i.test(error.message)) return c.json({ error: "domain_name_invalid" }, 400);
  return c.json({ error: "domain_operation_failed" }, 500);
}
