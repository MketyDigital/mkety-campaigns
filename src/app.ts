import { Hono } from "hono";
import { DomainConflictError, DomainProvisioningError, DomainRetryNotAvailableError, type TenantDomainService } from "./domains/service.js";
import type { VerificationType } from "./domains/azure-arm.js";
import { parseContactsCsv, validateCampaignDraft, validateContactImport, type CampaignChannel } from "./campaigns/service.js";
import type { CampaignWorkspace } from "./campaigns/workspace.js";
import { CampaignDispatchConflictError, type CampaignDispatchRepository } from "./campaigns/delivery-repository.js";
import type { OperationsService } from "./ops/service.js";
import { SenderDomainNotReadyError, SenderInputError, SenderProvisioningError, type TenantSenderService } from "./domains/senders.js";
import { TestSenderUnavailableError, type EmailTestSender } from "./email/test-send.js";

export type AppBindings = {
  Bindings: {
    DB?: D1Database;
    DATABASE_URL?: string;
  };
  Variables: {
    databaseReady: () => Promise<boolean>;
    tenantContext: { tenantId: string; userId: string };
    opsUserId: string;
  };
};

export type AuthSession = {
  user: { id: string; email?: string; role?: string; twoFactorEnabled?: boolean };
  session: { createdAt: Date | string };
};

export type AppSecurity = {
  trustedOrigins?: string[];
  auth: {
    handler(request: Request): Response | Promise<Response>;
    getSession(headers: Headers): Promise<AuthSession | null>;
  };
  resolveTenantSeat(userId: string, sessionCreatedAt: Date): Promise<string | null>;
  resolveOpsAdmin?(userId: string, sessionCreatedAt: Date): Promise<boolean>;
};

export function createApp(
  checkDatabase: () => Promise<boolean> = async () => false,
  security?: AppSecurity,
  domains?: TenantDomainService,
  workspace?: CampaignWorkspace,
  operations?: OperationsService,
  senders?: TenantSenderService,
  emailTestSender?: EmailTestSender,
  campaignDispatch?: CampaignDispatchRepository,
  campaignDispatchEnabled = false,
  campaignRecipientLimit = 100,
) {
  const app = new Hono<AppBindings>();

  app.use("*", async (c, next) => {
    c.set("databaseReady", checkDatabase);
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("X-Frame-Options", "DENY");
    if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/app") || c.req.path === "/login") {
      c.header("Cache-Control", "no-store");
    }
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
      .card a { display: inline-block; margin-top: 12px; color: #006fff; font-size: 13px; font-weight: 700; text-decoration: none; }
      .status { display: inline-flex; align-items: center; gap: 7px; color: #277650; font-size: 12px; font-weight: 700; }
      .dot { width: 7px; height: 7px; background: #32a46b; border-radius: 50%; }
      footer { margin-top: 32px; color: #8795a8; font-size: 12px; }
    </style>
  </head>
  <body>
    <header><div class="brand"><span class="mark">M</span><span>MKETY Campaigns</span></div><a href="/login" style="margin-left:auto;color:#006fff;font-weight:700;text-decoration:none">Sign in</a></header>
    <main>
      <div class="eyebrow">Standalone campaign platform</div>
      <h1>Your campaign workspace is starting here.</h1>
      <p class="intro">A focused workspace for consent-aware email and SMS campaigns, with isolated tenant data and controlled delivery.</p>
      <div class="grid">
        <section class="card"><h2>Campaigns</h2><p>Create and manage email or SMS drafts. Sending remains disabled until safety checks pass.</p><a href="/app/campaigns">Open campaigns →</a></section>
        <section class="card"><h2>Contacts</h2><p>Import only people with documented permission for the channel you select.</p><a href="/app/contacts">Manage contacts →</a></section>
        <section class="card"><h2>Sender domains</h2><p>Add your domain and publish the provider DNS records before enabling email delivery.</p><a href="/app/domains">Set up a sender domain →</a></section>
        <section class="card"><h2>Storage</h2><p>R2 is the primary object store. OCI archive and Azure backup are independent targets.</p></section>
        <section class="card"><h2>Delivery safety</h2><p>Sending stays disabled until provider, domain, and compliance checks are approved.</p></section>
      </div>
      <footer>MKETY Campaigns is independent from MKETY Mail and other MKETY systems.</footer>
    </main>
  </body>
</html>`));

  app.get("/app", async (c) => {
    if (!security) return c.redirect("/login", 302);
    const session = await security.auth.getSession(c.req.raw.headers);
    if (!session) return c.redirect("/login", 302);
    if (!session.user.twoFactorEnabled) return c.redirect("/app/setup-mfa", 302);
    const createdAt = new Date(session.session.createdAt);
    if (Number.isNaN(createdAt.getTime())) return c.redirect("/login", 302);
    if (session.user.role === "ops") {
      if (security.resolveOpsAdmin && await security.resolveOpsAdmin(session.user.id, createdAt)) return c.redirect("/app/ops", 302);
      return c.text("Ops access is not active for this account.", 403);
    }
    if (!await security.resolveTenantSeat(session.user.id, createdAt)) return c.text("No active customer workspace is assigned to this account.", 403);
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Campaign workspace · MKETY Campaigns</title><style>:root{font-family:Inter,system-ui,sans-serif;color:#10233f;background:#f5f8fc}*{box-sizing:border-box}body{margin:0}header{padding:22px max(24px,calc((100vw - 900px)/2));background:white;border-bottom:1px solid #e5ebf3}main{width:min(900px,calc(100% - 36px));margin:44px auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-top:26px}.card{padding:20px;background:white;border:1px solid #e4eaf2;border-radius:14px}.card p{color:#60728b;line-height:1.55}.card a{color:#006fff;font-weight:700;text-decoration:none}</style></head><body><header><a href="/">MKETY Campaigns</a></header><main><small>Customer workspace</small><h1>Campaign workspace</h1><p>Set up a sender domain, manage permission-based contacts, and prepare campaigns for review.</p><section class="grid"><article class="card"><h2>Sender domains</h2><p>Publish DNS records and confirm domain readiness.</p><a href="/app/domains">Manage domains →</a></article><article class="card"><h2>Sender addresses</h2><p>Create an authorized From address and test it to your account email.</p><a href="/app/senders">Manage sender addresses →</a></article><article class="card"><h2>Contacts</h2><p>Import contacts with channel-specific consent evidence.</p><a href="/app/contacts">Manage contacts →</a></article><article class="card"><h2>Campaigns</h2><p>Create drafts and submit them to Ops for review.</p><a href="/app/campaigns">Manage campaigns →</a></article></section></main></body></html>`);
  });

  app.get("/app/contacts", (c) => c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Contacts · MKETY Campaigns</title>
<style>:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#10233f;background:#f5f8fc}*{box-sizing:border-box}body{margin:0}header{height:68px;display:flex;align-items:center;padding:0 max(24px,calc((100vw - 960px)/2));background:white;border-bottom:1px solid #e5ebf3}a{color:#006fff;text-decoration:none;font-weight:700}main{width:min(960px,calc(100% - 36px));margin:40px auto}.panel,.contact{background:white;border:1px solid #e4eaf2;border-radius:14px;padding:20px;margin-top:16px}h1{margin:10px 0}p{color:#60728b;line-height:1.5}.form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}label{display:grid;gap:6px;font-size:13px;color:#50627a}input,select{padding:11px;border:1px solid #cbd6e4;border-radius:8px;font:inherit}button{border:0;border-radius:8px;padding:11px 15px;background:#006fff;color:white;font:inherit;font-weight:700;cursor:pointer}.wide{grid-column:1/-1}#notice{min-height:20px;color:#9a3b23}@media(max-width:620px){.form{grid-template-columns:1fr}}</style></head>
<body><header><a href="/">MKETY Campaigns</a>&nbsp; / &nbsp;Contacts</header><main><small>Audience</small><h1>Contacts</h1><p>Only add contacts who explicitly opted in to the channel you select. Keep the original consent source and evidence reference.</p>
<section class="panel"><h2>Import permission-based contacts</h2><form id="csv-form" class="form"><label>Choose a CSV file<input id="csv-file" type="file" accept=".csv,text/csv" required></label><label>Channel<select id="csv-channel"><option value="email">Email</option><option value="sms">SMS</option></select></label><button type="submit">Validate and import CSV</button></form><p class="hint">Required columns: email or phone, the channel consent column, consent_source, consent_evidence_ref, consent_occurred_at. Every row must contain valid, affirmative consent evidence.</p><details><summary>Or add one contact manually</summary><form id="import-form" class="form">
<label>Channel<select name="channel"><option value="email">Email</option><option value="sms">SMS</option></select></label>
<label>Name<input name="displayName" maxlength="200"></label><label>Email<input name="email" type="email"></label><label>Phone (international, e.g. +234...)<input name="phone" type="tel"></label>
<label>Consent source<input name="consentSource" placeholder="Website form, event registration…" required></label><label>Evidence reference<input name="consentEvidenceRef" placeholder="Form ID or record reference" required></label>
<label>Consent time<input name="consentOccurredAt" type="datetime-local" required></label><label>Permission<input name="consent" type="checkbox" required> Contact agreed to this channel</label>
<button class="wide" type="submit">Save contact with consent</button></form></details><p id="notice" role="status"></p></section><section id="contacts"></section></main>
<script>
const form=document.getElementById('import-form'),csvForm=document.getElementById('csv-form'),notice=document.getElementById('notice'),list=document.getElementById('contacts');
async function load(){try{const r=await fetch('/api/tenant/contacts',{credentials:'same-origin'}),d=await r.json();if(!r.ok)throw Error(d.error);list.replaceChildren();for(const c of d.contacts||[]){const el=document.createElement('article');el.className='contact';const label=document.createElement('p');label.textContent=[c.displayName,c.email,c.phoneE164].filter(Boolean).join(' · ');el.append(label);for(const [channel,address,text] of [['email',c.email,'Withdraw email consent'],['sms',c.phoneE164,'Withdraw SMS consent']]){if(!address)continue;const button=document.createElement('button');button.type='button';button.textContent=text;button.addEventListener('click',async()=>{if(!confirm('Record this contact as opted out of '+channel+'?'))return;try{const response=await fetch('/api/tenant/contacts/'+encodeURIComponent(c.id)+'/withdraw',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({channel})}),result=await response.json();if(!response.ok)throw Error(result.error);notice.textContent='Consent withdrawal recorded; this address is suppressed for '+channel+'.'}catch(error){notice.textContent='Could not record the consent withdrawal.'}});el.append(button)}list.append(el)}if(!list.childElementCount)list.textContent='No contacts yet.'}catch(e){list.textContent=e.message==='unauthorized'?'Sign in to manage contacts.':'Contacts could not be loaded.'}}
form.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(form),channel=f.get('channel'),row={email:f.get('email'),phone:f.get('phone'),displayName:f.get('displayName'),consentSource:f.get('consentSource'),consentEvidenceRef:f.get('consentEvidenceRef'),consentOccurredAt:new Date(f.get('consentOccurredAt')).toISOString(),emailConsent:channel==='email',smsConsent:channel==='sms'};try{const r=await fetch('/api/tenant/contacts/import',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({channel,rows:[row]})}),d=await r.json();if(!r.ok)throw Error(d.error);form.reset();notice.textContent='Contact saved with consent evidence.';await load()}catch(err){notice.textContent=err.message==='unauthorized'?'Sign in before importing contacts.':'Check the contact details and consent evidence, then try again.'}});load();
csvForm.addEventListener('submit',async e=>{e.preventDefault();const file=document.getElementById('csv-file').files[0],channel=document.getElementById('csv-channel').value;if(!file)return;try{const r=await fetch('/api/tenant/contacts/import-csv?channel='+channel,{method:'POST',credentials:'same-origin',headers:{'content-type':'text/csv'},body:await file.text()}),d=await r.json();if(!r.ok)throw Error(d.message||d.error);csvForm.reset();notice.textContent='CSV contacts imported with consent evidence.';await load()}catch(err){notice.textContent=err.message.includes('unauthorized')?'Sign in before importing contacts.':err.message.startsWith('CSV')?err.message:'Check the CSV format and consent evidence, then try again.'}});load();
</script></body></html>`));

  app.get("/app/campaigns", (c) => c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Campaigns · MKETY Campaigns</title>
<style>:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#10233f;background:#f5f8fc}*{box-sizing:border-box}body{margin:0}header{height:68px;display:flex;align-items:center;padding:0 max(24px,calc((100vw - 960px)/2));background:white;border-bottom:1px solid #e5ebf3}a{color:#006fff;text-decoration:none;font-weight:700}main{width:min(960px,calc(100% - 36px));margin:40px auto}.panel,.campaign{background:white;border:1px solid #e4eaf2;border-radius:14px;padding:20px;margin-top:16px}h1{margin:10px 0}p{color:#60728b;line-height:1.5}.form{display:grid;gap:12px}label{display:grid;gap:6px;font-size:13px;color:#50627a}input,select,textarea{padding:11px;border:1px solid #cbd6e4;border-radius:8px;font:inherit}textarea{min-height:160px;resize:vertical}button{border:0;border-radius:8px;padding:11px 15px;background:#006fff;color:white;font:inherit;font-weight:700;cursor:pointer}#notice{min-height:20px;color:#9a3b23}</style></head>
<body><header><a href="/">MKETY Campaigns</a>&nbsp; / &nbsp;Campaigns</header><main><small>Delivery</small><h1>Campaigns</h1><p>Save a draft and review it before scheduling. The sender is assigned from your verified domain; sending is not triggered by saving a draft.</p>
<section class="panel"><h2>Create a campaign draft</h2><form id="campaign-form" class="form"><label>Channel<select name="channel" id="channel"><option value="email">Email</option><option value="sms">SMS</option></select></label><label id="sender-label">Verified sender<select name="senderIdentityId" id="sender-id" required></select></label><label id="subject-label">Email subject<input name="subject" maxlength="998"></label><label>Message<textarea name="bodyText" required></textarea></label><label>Planned send time (optional)<input name="scheduledAt" type="datetime-local"></label><button type="submit">Save draft</button></form><p id="notice" role="status"></p></section><section id="campaign-list"></section></main>
<script>
const form=document.getElementById('campaign-form'),channel=document.getElementById('channel'),subject=document.getElementById('subject-label'),senderLabel=document.getElementById('sender-label'),senderSelect=document.getElementById('sender-id'),notice=document.getElementById('notice'),list=document.getElementById('campaign-list');channel.addEventListener('change',()=>{subject.hidden=channel.value==='sms';senderLabel.hidden=channel.value==='sms';senderSelect.required=channel.value==='email'});
async function load(){try{const [campaignResponse,senderResponse]=await Promise.all([fetch('/api/tenant/campaigns',{credentials:'same-origin'}),fetch('/api/tenant/senders',{credentials:'same-origin'})]),d=await campaignResponse.json(),senderData=await senderResponse.json();if(!campaignResponse.ok)throw Error(d.error);senderSelect.replaceChildren();for(const sender of senderData.senders||[]){if(sender.status!=='ready')continue;const option=document.createElement('option');option.value=sender.id;option.textContent=sender.displayName+' <'+sender.senderAddress+'>';senderSelect.append(option)}if(!senderSelect.options.length){const option=document.createElement('option');option.value='';option.textContent='Create a ready sender address first';option.disabled=true;option.selected=true;senderSelect.append(option)}list.replaceChildren();for(const c of d.campaigns||[]){const el=document.createElement('article');el.className='campaign';const title=document.createElement('strong');title.textContent=(c.subject||'SMS campaign')+' · '+c.channel;const status=document.createElement('p');status.textContent='Status: '+c.status+' · Created '+new Date(c.createdAt).toLocaleString();el.append(title,status);if(c.status==='draft'){const submit=document.createElement('button');submit.textContent='Submit for review';submit.addEventListener('click',async()=>{try{const response=await fetch('/api/tenant/campaigns/'+encodeURIComponent(c.id)+'/submit',{method:'POST',credentials:'same-origin'}),result=await response.json();if(!response.ok)throw Error(result.error);notice.textContent='Campaign submitted for Ops review. It has not been sent.';await load()}catch(error){notice.textContent='Campaign could not be submitted for review.'}});el.append(submit)}list.append(el)}if(!list.childElementCount)list.textContent='No campaign drafts yet.'}catch(e){list.textContent=e.message==='unauthorized'?'Sign in to manage campaigns.':'Campaigns could not be loaded.'}}
form.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(form),payload={channel:f.get('channel'),senderIdentityId:f.get('channel')==='email'?f.get('senderIdentityId'):undefined,subject:f.get('subject'),bodyText:f.get('bodyText'),scheduledAt:f.get('scheduledAt')?new Date(f.get('scheduledAt')).toISOString():undefined};try{const r=await fetch('/api/tenant/campaigns',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}),d=await r.json();if(!r.ok)throw Error(d.error);form.reset();channel.dispatchEvent(new Event('change'));notice.textContent='Draft saved. It has not been sent.';await load()}catch(err){notice.textContent=err.message==='campaign_sender_required'||err.message==='campaign_sender_not_ready'?'Create a ready sender address first.':'Check the campaign content and try again.'}});channel.dispatchEvent(new Event('change'));load();
</script></body></html>`));

  app.get("/login", (c) => c.html(loginPageHtml));
  app.get("/app/setup-mfa", (c) => c.html(mfaSetupPageHtml));
  app.get("/app/ops", (c) => c.html(operationsPageHtml));
  app.get("/invite/accept", (c) => c.html(inviteAcceptPageHtml));
  app.get("/app/senders", (c) => c.html(senderIdentitiesPageHtml));

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
      <p class="intro">Add a domain you own, publish the DNS records shown below, then refresh verification. Keep one SPF TXT record per host; merge the provider value into any existing SPF record. A dedicated sending subdomain such as <strong>mail.example.com</strong> is a good starting point.</p>
      <section class="panel">
        <h2>Add a sender domain</h2>
        <p class="hint">Use a domain or subdomain you control. Email sending stays disabled until the configured email provider verifies the records and activates the domain.</p>
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
          const state = document.createElement('p'); state.className = 'status'; state.textContent = 'Provider: ' + label(domain.provider) + ' · Provisioning: ' + label(domain.provisioningState);
          details.append(title, state);
          const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = domain.linked ? 'Linked and verified' : 'DNS setup required';
          head.append(details, badge); card.append(head);
          const entries = Object.entries(domain.verificationRecords || {});
          if (!entries.length) {
            const note = document.createElement('p'); note.className = 'muted'; note.textContent = 'The email provider is preparing the DNS records. Refresh in a moment.'; card.append(note);
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
        catch (error) { notice.textContent = error.message === 'domain_already_registered' ? 'That domain is already registered.' : error.message === 'domain_name_invalid' ? 'Enter a valid domain or subdomain.' : error.message === 'domain_provider_failed' ? 'The email provider could not create this domain. Check its setup and try again.' : 'Could not add the domain. Please try again.'; }
        finally { button.disabled = false; }
      });
      load();
    </script>
  </body>
</html>`));

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/unsubscribe", (c) => c.html(unsubscribePageHtml(c.req.query("token") ?? ""), 200, { "cache-control": "no-store" }));
  app.post("/unsubscribe", async (c) => {
    if (!workspace) return c.text("This unsubscribe link is unavailable.", 503);
    const contentType = c.req.header("content-type") ?? "";
    const token = contentType.includes("application/json")
      ? ((await c.req.json().catch(() => null) as { token?: unknown } | null)?.token)
      : ((await c.req.formData().catch(() => null))?.get("token") ?? c.req.query("token"));
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) return c.text("This unsubscribe link is invalid or expired.", 400);
    try {
      const unsubscribed = await workspace.unsubscribe(token);
      return c.text(unsubscribed ? "You are unsubscribed from these campaign emails." : "This unsubscribe link is invalid or expired.", unsubscribed ? 200 : 404, { "cache-control": "no-store" });
    } catch {
      return c.text("We could not process this request. Please try again.", 503, { "cache-control": "no-store" });
    }
  });
  app.get("/readyz", async (c) => {
    const ready = await c.get("databaseReady")();
    return c.json({ status: ready ? "ready" : "not_ready" }, ready ? 200 : 503);
  });

  app.all("/api/auth/*", (c) => security
    ? security.auth.handler(c.req.raw)
    : c.json({ error: "auth_not_configured" }, 503));

  app.use("/api/tenant/*", async (c, next) => {
    if (!security) return c.json({ error: "auth_not_configured" }, 503);
    if (!isTrustedMutationOrigin(c.req.raw, security.trustedOrigins)) return c.json({ error: "untrusted_origin" }, 403);
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

  app.use("/api/ops/*", async (c, next) => {
    if (!security) return c.json({ error: "auth_not_configured" }, 503);
    if (!isTrustedMutationOrigin(c.req.raw, security.trustedOrigins)) return c.json({ error: "untrusted_origin" }, 403);
    const session = await security.auth.getSession(c.req.raw.headers);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    if (!session.user.twoFactorEnabled || session.user.role !== "ops") return c.json({ error: "forbidden" }, 403);
    const createdAt = new Date(session.session.createdAt);
    if (Number.isNaN(createdAt.getTime()) || !security.resolveOpsAdmin || !await security.resolveOpsAdmin(session.user.id, createdAt)) {
      return c.json({ error: "forbidden" }, 403);
    }
    c.set("opsUserId", session.user.id);
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

  app.get("/api/tenant/senders", async (c) => {
    if (!senders) return c.json({ error: "sender_management_not_configured" }, 503);
    try {
      return c.json({ senders: await senders.list(c.get("tenantContext").tenantId) });
    } catch {
      return c.json({ error: "senders_unavailable" }, 500);
    }
  });

  app.post("/api/tenant/senders", async (c) => {
    if (!senders) return c.json({ error: "sender_management_not_configured" }, 503);
    const payload = await c.req.json().catch(() => null) as { domainId?: unknown; username?: unknown; displayName?: unknown } | null;
    if (!payload || typeof payload.domainId !== "string" || typeof payload.username !== "string" || typeof payload.displayName !== "string") {
      return c.json({ error: "sender_identity_invalid" }, 400);
    }
    try {
      const sender = await senders.create(c.get("tenantContext").tenantId, payload.domainId, payload.username, payload.displayName);
      return c.json({ sender }, 201);
    } catch (error) {
      if (error instanceof SenderDomainNotReadyError) return c.json({ error: "sender_domain_not_ready" }, 409);
      if (error instanceof SenderInputError) return c.json({ error: "sender_identity_invalid" }, 400);
      if (error instanceof SenderProvisioningError) return c.json({ error: "sender_provider_failed" }, 502);
      if (isUniqueViolation(error)) return c.json({ error: "sender_already_exists" }, 409);
      return c.json({ error: "sender_identity_failed" }, 500);
    }
  });

  app.post("/api/tenant/senders/:id/refresh", async (c) => {
    if (!senders) return c.json({ error: "sender_management_not_configured" }, 503);
    try {
      const sender = await senders.refresh(c.get("tenantContext").tenantId, c.req.param("id"));
      return sender ? c.json({ sender }) : c.json({ error: "sender_not_found" }, 404);
    } catch (error) {
      if (error instanceof SenderDomainNotReadyError) return c.json({ error: "sender_domain_not_ready" }, 409);
      if (error instanceof SenderProvisioningError) return c.json({ error: "sender_provider_failed" }, 502);
      return c.json({ error: "sender_refresh_failed" }, 500);
    }
  });

  app.post("/api/tenant/senders/:id/test", async (c) => {
    if (!emailTestSender) return c.json({ error: "email_test_send_disabled" }, 503);
    const session = await security?.auth.getSession(c.req.raw.headers);
    const accountEmail = session?.user.email;
    if (!accountEmail) return c.json({ error: "account_email_unavailable" }, 403);
    try {
      const result = await emailTestSender.sendToAccountOwner(c.get("tenantContext").tenantId, c.req.param("id"), accountEmail);
      return c.json({ accepted: true, provider: result.provider, acceptedAt: result.acceptedAt });
    } catch (error) {
      if (error instanceof TestSenderUnavailableError) return c.json({ error: "sender_not_ready" }, 409);
      return c.json({ error: "email_test_send_failed" }, 502);
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

  app.get("/api/tenant/contacts", async (c) => {
    if (!workspace) return c.json({ error: "campaign_workspace_not_configured" }, 503);
    try {
      return c.json({ contacts: await workspace.listContacts(c.get("tenantContext").tenantId) });
    } catch {
      return c.json({ error: "contacts_unavailable" }, 500);
    }
  });

  app.post("/api/tenant/contacts/import", async (c) => {
    if (!workspace) return c.json({ error: "campaign_workspace_not_configured" }, 503);
    const payload = await c.req.json().catch(() => null) as { channel?: unknown; rows?: unknown } | null;
    if (!payload || (payload.channel !== "email" && payload.channel !== "sms") || !Array.isArray(payload.rows) || payload.rows.length < 1 || payload.rows.length > 100) {
      return c.json({ error: "contact_import_invalid" }, 400);
    }
    try {
      const channel = payload.channel as CampaignChannel;
      const rows = payload.rows.map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Contact row is invalid");
        return validateContactImport(row as Parameters<typeof validateContactImport>[0], channel);
      });
      const result = await workspace.importContacts(c.get("tenantContext").tenantId, channel, rows);
      return c.json(result, 201);
    } catch (error) {
      if (error instanceof Error && /valid |required|invalid|consent|contact email and phone/i.test(error.message)) {
        return c.json({ error: "contact_import_invalid" }, 400);
      }
      return c.json({ error: "contact_import_failed" }, 500);
    }
  });

  app.post("/api/tenant/contacts/:id/withdraw", async (c) => {
    if (!workspace) return c.json({ error: "campaign_workspace_not_configured" }, 503);
    const payload = await c.req.json().catch(() => null) as { channel?: unknown } | null;
    if (payload?.channel !== "email" && payload?.channel !== "sms") return c.json({ error: "contact_channel_invalid" }, 400);
    try {
      const withdrawn = await workspace.withdrawConsent(c.get("tenantContext").tenantId, c.req.param("id"), payload.channel);
      return withdrawn ? c.json({ withdrawn: true }) : c.json({ error: "contact_channel_not_found" }, 404);
    } catch {
      return c.json({ error: "contact_consent_withdrawal_failed" }, 500);
    }
  });

  app.post("/api/tenant/contacts/import-csv", async (c) => {
    if (!workspace) return c.json({ error: "campaign_workspace_not_configured" }, 503);
    const channel = c.req.query("channel");
    if (channel !== "email" && channel !== "sms") return c.json({ error: "contact_import_invalid" }, 400);
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (contentLength > 1_000_000) return c.json({ error: "contact_csv_too_large" }, 413);
    try {
      const csv = await c.req.text();
      const rows = parseContactsCsv(csv, channel);
      const result = await workspace.importContacts(c.get("tenantContext").tenantId, channel, rows);
      return c.json(result, 201);
    } catch (error) {
      if (error instanceof Error && /CSV|valid |required|invalid|consent|contact email and phone/i.test(error.message)) {
        return c.json({ error: "contact_csv_invalid", message: error.message.slice(0, 200) }, 400);
      }
      return c.json({ error: "contact_import_failed" }, 500);
    }
  });

  app.get("/api/tenant/campaigns", async (c) => {
    if (!workspace) return c.json({ error: "campaign_workspace_not_configured" }, 503);
    try {
      return c.json({ campaigns: await workspace.listCampaigns(c.get("tenantContext").tenantId) });
    } catch {
      return c.json({ error: "campaigns_unavailable" }, 500);
    }
  });

  app.post("/api/tenant/campaigns", async (c) => {
    if (!workspace) return c.json({ error: "campaign_workspace_not_configured" }, 503);
    const payload = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!payload) return c.json({ error: "campaign_draft_invalid" }, 400);
    try {
      const draft = validateCampaignDraft(payload);
      const tenantId = c.get("tenantContext").tenantId;
      if (draft.channel === "email") {
        if (!draft.senderIdentityId || !senders) return c.json({ error: "campaign_sender_required" }, 400);
        const sender = await senders.get(tenantId, draft.senderIdentityId);
        if (!sender || sender.status !== "ready") return c.json({ error: "campaign_sender_not_ready" }, 409);
      }
      const campaign = await workspace.createCampaign(tenantId, draft);
      return c.json({ campaign }, 201);
    } catch (error) {
      if (error instanceof Error && /required|valid|too long|channel/i.test(error.message)) return c.json({ error: "campaign_draft_invalid" }, 400);
      return c.json({ error: "campaign_save_failed" }, 500);
    }
  });

  app.post("/api/tenant/campaigns/:id/submit", async (c) => {
    if (!workspace) return c.json({ error: "campaign_workspace_not_configured" }, 503);
    try {
      const campaign = await workspace.submitForReview(c.get("tenantContext").tenantId, c.req.param("id"));
      return campaign ? c.json({ campaign }) : c.json({ error: "campaign_not_found_or_not_a_draft" }, 409);
    } catch {
      return c.json({ error: "campaign_submission_failed" }, 500);
    }
  });

  app.post("/api/ops/tenant-invitations", async (c) => {
    if (!operations) return c.json({ error: "operations_not_configured" }, 503);
    const payload = await c.req.json().catch(() => null) as { tenantName?: unknown; email?: unknown } | null;
    if (!payload || typeof payload.tenantName !== "string" || typeof payload.email !== "string") return c.json({ error: "invite_invalid" }, 400);
    try {
      const result = await operations.createTenantInvite(payload.tenantName, payload.email);
      return c.json(result, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/valid email|tenant name/i.test(message)) return c.json({ error: "invite_invalid" }, 400);
      if (/already (has an account|exists)/i.test(message)) return c.json({ error: "invite_conflict" }, 409);
      return c.json({ error: "invite_failed" }, 500);
    }
  });

  app.get("/api/ops/campaigns/review", async (c) => {
    if (!workspace) return c.json({ error: "campaign_workspace_not_configured" }, 503);
    try {
      return c.json({ campaigns: await workspace.listCampaignsInReview() });
    } catch {
      return c.json({ error: "campaign_review_unavailable" }, 500);
    }
  });

  app.get("/api/ops/campaigns/approved", async (c) => {
    if (!workspace) return c.json({ error: "campaign_workspace_not_configured" }, 503);
    try {
      return c.json({ campaigns: await workspace.listApprovedCampaigns(), dispatchEnabled: campaignDispatchEnabled, recipientLimit: campaignRecipientLimit });
    } catch {
      return c.json({ error: "campaign_review_unavailable" }, 500);
    }
  });

  app.post("/api/ops/campaigns/:id/dispatch", async (c) => {
    if (!campaignDispatchEnabled) return c.json({ error: "campaign_dispatch_disabled" }, 503);
    if (!campaignDispatch) return c.json({ error: "campaign_dispatch_not_configured" }, 503);
    try {
      const queued = await campaignDispatch.queueApproved(c.req.param("id"), c.get("opsUserId"), campaignRecipientLimit);
      return c.json({ queued, status: "queued" }, 202);
    } catch (error) {
      if (error instanceof CampaignDispatchConflictError) return c.json({ error: "campaign_not_queueable", message: error.message }, 409);
      return c.json({ error: "campaign_dispatch_failed" }, 500);
    }
  });

  app.post("/api/ops/campaigns/:id/review", async (c) => {
    if (!workspace) return c.json({ error: "campaign_workspace_not_configured" }, 503);
    const payload = await c.req.json().catch(() => null) as { decision?: unknown } | null;
    if (payload?.decision !== "approve" && payload?.decision !== "reject") return c.json({ error: "campaign_review_decision_invalid" }, 400);
    try {
      const campaign = await workspace.reviewCampaign(c.req.param("id"), c.get("opsUserId"), payload.decision);
      return campaign ? c.json({ campaign, deliveryQueued: false }) : c.json({ error: "campaign_not_found_or_not_in_review" }, 409);
    } catch {
      return c.json({ error: "campaign_review_failed" }, 500);
    }
  });

  app.post("/api/invitations/accept", async (c) => {
    if (!operations) return c.json({ error: "invitations_not_configured" }, 503);
    const payload = await c.req.json().catch(() => null) as { token?: unknown; displayName?: unknown; password?: unknown } | null;
    if (!payload || typeof payload.token !== "string" || typeof payload.displayName !== "string" || typeof payload.password !== "string") return c.json({ error: "invite_invalid" }, 400);
    try {
      const accepted = await operations.acceptInvite(payload.token, payload.displayName, payload.password);
      return accepted ? c.json({ accepted: true }, 201) : c.json({ error: "invite_invalid_or_expired" }, 410);
    } catch (error) {
      if (error instanceof Error && /password|name/i.test(error.message)) return c.json({ error: "invite_invalid" }, 400);
      return c.json({ error: "invite_accept_failed" }, 500);
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

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "23505" || error.code === "SQLITE_CONSTRAINT_UNIQUE");
}

const operationsPageHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MKETY Ops · Campaigns</title><style>:root{font-family:Inter,system-ui,sans-serif;color:#10233f;background:#f5f8fc}*{box-sizing:border-box}body{margin:0}header{padding:22px max(24px,calc((100vw - 760px)/2));background:white;border-bottom:1px solid #e5ebf3}main{width:min(760px,calc(100% - 36px));margin:42px auto}.panel,.review{padding:22px;background:white;border:1px solid #e4eaf2;border-radius:14px;margin:16px 0}label{display:grid;gap:6px;margin:14px 0;color:#50627a;font-size:13px}input{padding:11px;border:1px solid #cbd6e4;border-radius:8px;font:inherit}button{border:0;border-radius:8px;padding:11px 15px;background:#006fff;color:white;font:inherit;font-weight:700;cursor:pointer}button.reject{background:#66758a;margin-left:8px}p{color:#60728b;line-height:1.55}#result,#review-result{overflow-wrap:anywhere}</style><meta name="referrer" content="no-referrer"></head><body><header><a href="/">MKETY Campaigns</a> / Ops administration</header><main><h1>Approve a customer workspace</h1><p>Creates one approved tenant and a single-use account invitation. Copy the link and send it to the invited owner through your chosen channel. The link expires after seven days.</p><section class="panel"><form id="invite-form"><label>Business name<input name="tenantName" maxlength="160" required></label><label>Owner email<input name="email" type="email" maxlength="254" required></label><button type="submit">Create invite</button></form><p id="result" role="status"></p></section><h2>Campaigns awaiting review</h2><p>Approval records the Ops decision only. It does not queue or send messages.</p><p id="review-result" role="status"></p><section id="review-list"></section><h2>Approved email campaigns</h2><p>Queueing is a separate, explicit action. The worker sends at most one message per job and stops for manual review after uncertain provider results.</p><p id="dispatch-result" role="status"></p><section id="approved-list"></section></main><script>const form=document.getElementById('invite-form'),result=document.getElementById('result'),reviewList=document.getElementById('review-list'),reviewResult=document.getElementById('review-result'),approvedList=document.getElementById('approved-list'),dispatchResult=document.getElementById('dispatch-result');form.addEventListener('submit',async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(form));try{const r=await fetch('/api/ops/tenant-invitations',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(data)}),payload=await r.json();if(!r.ok)throw Error(payload.error);result.textContent='Invite created. Copy and send this one-time link: '+payload.inviteUrl;form.reset()}catch(error){result.textContent=error.message==='unauthorized'||error.message==='forbidden'?'Sign in as an MFA-enabled Ops administrator.':'Invite could not be created. Check the business name and email.'}});async function loadReviews(){try{const r=await fetch('/api/ops/campaigns/review',{credentials:'same-origin'}),d=await r.json();if(!r.ok)throw Error(d.error);reviewList.replaceChildren();for(const c of d.campaigns||[]){const card=document.createElement('article');card.className='review';const title=document.createElement('strong');title.textContent=(c.subject||'SMS campaign')+' · '+c.channel+' · '+c.tenantId;const body=document.createElement('p');body.textContent=c.bodyText;card.append(title,body);for(const decision of ['approve','reject']){const button=document.createElement('button');button.textContent=decision==='approve'?'Approve':'Reject';if(decision==='reject')button.className='reject';button.addEventListener('click',async()=>{try{const response=await fetch('/api/ops/campaigns/'+encodeURIComponent(c.id)+'/review',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({decision})}),result=await response.json();if(!response.ok)throw Error(result.error);reviewResult.textContent='Decision recorded. No message was sent.';await loadReviews()}catch(error){reviewResult.textContent='Could not record the review decision.'}});card.append(button)}reviewList.append(card)}if(!reviewList.childElementCount)reviewList.textContent='No campaigns are waiting for review.'}catch(error){reviewList.textContent='Sign in as an MFA-enabled Ops administrator to view this queue.'}}async function loadApproved(){try{const r=await fetch('/api/ops/campaigns/approved',{credentials:'same-origin'}),d=await r.json();if(!r.ok)throw Error(d.error);approvedList.replaceChildren();for(const c of d.campaigns||[]){const card=document.createElement('article');card.className='review';const title=document.createElement('strong');title.textContent=(c.subject||'SMS campaign')+' · '+c.channel+' · '+c.tenantId;const body=document.createElement('p');body.textContent=c.bodyText;card.append(title,body);if(c.channel==='email'&&d.dispatchEnabled){const button=document.createElement('button');button.textContent='Queue campaign delivery';button.addEventListener('click',async()=>{if(!confirm('Queue this approved email campaign for up to '+d.recipientLimit+' eligible, consented recipients? This starts real email delivery.'))return;button.disabled=true;try{const response=await fetch('/api/ops/campaigns/'+encodeURIComponent(c.id)+'/dispatch',{method:'POST',credentials:'same-origin'}),result=await response.json();if(!response.ok)throw Error(result.error);dispatchResult.textContent='Queued '+result.queued+' recipient messages. The worker will process them.';await loadApproved()}catch(error){dispatchResult.textContent=error.message==='campaign_dispatch_disabled'?'Campaign delivery is disabled by the operator.':'This campaign could not be queued. Check sender readiness, consent, suppression, and the recipient cap.'}finally{button.disabled=false}});card.append(button)}approvedList.append(card)}if(!approvedList.childElementCount)approvedList.textContent='No approved campaigns.'}catch(error){approvedList.textContent='Sign in as an MFA-enabled Ops administrator to view approved campaigns.'}}loadReviews();loadApproved();</script></body></html>`;

const senderIdentitiesPageHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sender addresses · MKETY Campaigns</title><style>:root{font-family:Inter,system-ui,sans-serif;color:#10233f;background:#f5f8fc}*{box-sizing:border-box}body{margin:0}header{padding:22px max(24px,calc((100vw - 760px)/2));background:white;border-bottom:1px solid #e5ebf3}main{width:min(760px,calc(100% - 36px));margin:42px auto}.panel,.sender{padding:20px;background:white;border:1px solid #e4eaf2;border-radius:14px;margin:16px 0}label{display:grid;gap:6px;margin:14px 0;color:#50627a;font-size:13px}input,select{padding:11px;border:1px solid #cbd6e4;border-radius:8px;font:inherit}button{border:0;border-radius:8px;padding:11px 15px;background:#006fff;color:white;font:inherit;font-weight:700;cursor:pointer;margin:4px}button:disabled{opacity:.5}p{color:#60728b;line-height:1.55}#notice{min-height:22px;overflow-wrap:anywhere}</style><meta name="referrer" content="no-referrer"></head><body><header><a href="/app">MKETY Campaigns</a> / Sender addresses</header><main><h1>Sender addresses</h1><p>Create a sender username under one of your verified, linked email domains. The sender is saved by the server; the browser cannot choose a From address for messages.</p><section class="panel"><form id="sender-form"><label>Verified linked domain<select id="domain-id" name="domainId" required></select></label><label>Address name<input name="username" placeholder="info" maxlength="64" required></label><label>Display name<input name="displayName" placeholder="MKETY Updates" maxlength="100" required></label><button type="submit">Create sender identity</button></form><p>Test email sends one fixed message to the email address on your signed-in account. It never sends to an address entered on this page.</p><p id="notice" role="status"></p></section><section id="sender-list"></section></main><script>const form=document.getElementById('sender-form'),domainSelect=document.getElementById('domain-id'),list=document.getElementById('sender-list'),notice=document.getElementById('notice');async function request(path,init){const response=await fetch(path,{credentials:'same-origin',...init,headers:{'content-type':'application/json',...(init&&init.headers||{})}}),data=await response.json().catch(()=>({}));if(!response.ok)throw Error(data.error||'Request failed');return data}async function load(){try{const [domainData,senderData]=await Promise.all([request('/api/tenant/domains'),request('/api/tenant/senders')]);domainSelect.replaceChildren();for(const domain of domainData.domains||[]){const records=Object.keys(domain.verificationRecords||{}),verified=records.length>0&&records.every(type=>domain.verificationStates?.[type]?.status==='Verified');if(!verified||!domain.linked||domain.provisioningState!=='Succeeded')continue;const option=document.createElement('option');option.value=domain.id;option.textContent=domain.domainName;domainSelect.append(option)}if(!domainSelect.options.length){const option=document.createElement('option');option.textContent='Add and verify a sender domain first';option.disabled=true;option.selected=true;domainSelect.append(option)}list.replaceChildren();for(const sender of senderData.senders||[]){const card=document.createElement('article');card.className='sender';const title=document.createElement('strong');title.textContent=sender.displayName+' <'+sender.senderAddress+'>';const status=document.createElement('p');status.textContent='Status: '+sender.status;card.append(title,status);if(sender.status==='pending'){const refresh=document.createElement('button');refresh.textContent='Refresh provisioning status';refresh.addEventListener('click',async()=>{refresh.disabled=true;try{await request('/api/tenant/senders/'+encodeURIComponent(sender.id)+'/refresh',{method:'POST',body:'{}'});notice.textContent='Sender status refreshed.';await load()}catch(error){notice.textContent='The email provider could not refresh this sender. Try again shortly.'}finally{refresh.disabled=false}});card.append(refresh)}if(sender.status==='ready'){const button=document.createElement('button');button.textContent='Send test email to your signed-in account';button.addEventListener('click',async()=>{if(!confirm('Send one real test email from '+sender.senderAddress+' to the email address on your signed-in account?'))return;button.disabled=true;try{await request('/api/tenant/senders/'+encodeURIComponent(sender.id)+'/test',{method:'POST',body:'{}'});notice.textContent='Provider accepted the test email for delivery.'}catch(error){notice.textContent=error.message==='email_test_send_disabled'?'Test sending is disabled by the operator.':error.message==='sender_not_ready'?'This sender is not ready for testing.':'The provider did not accept the test email.'}finally{button.disabled=false}});card.append(button)}list.append(card)}if(!list.childElementCount)list.textContent='No sender identities yet.'}catch(error){notice.textContent='Sign in and verify a linked sender domain before creating a sender address.'}}form.addEventListener('submit',async event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form));try{await request('/api/tenant/senders',{method:'POST',body:JSON.stringify(data)});notice.textContent='Sender identity created. If the provider is still provisioning it, refresh after a moment.';form.reset();await load()}catch(error){notice.textContent=error.message==='sender_domain_not_ready'?'Verify and link the domain before creating a sender.':error.message==='sender_provider_failed'?'The email provider could not create that sender. Check its configuration.':'Could not create sender identity. Check the name and try again.'}});load();</script></body></html>`;

const loginPageHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · MKETY Campaigns</title><style>:root{font-family:Inter,system-ui,sans-serif;color:#10233f;background:#f5f8fc}*{box-sizing:border-box}body{margin:0}main{width:min(440px,calc(100% - 36px));margin:12vh auto}.panel{padding:24px;background:white;border:1px solid #e4eaf2;border-radius:14px}label{display:grid;gap:6px;margin:14px 0}input{padding:11px;border:1px solid #cbd6e4;border-radius:8px;font:inherit}button{border:0;border-radius:8px;padding:11px 15px;background:#006fff;color:white;font:inherit;font-weight:700;cursor:pointer}#code-step{display:none}#result{color:#9a3b23;min-height:22px}</style></head><body><main><section class="panel"><a href="/">MKETY Campaigns</a><h1>Sign in to MKETY Campaigns</h1><form id="login-form"><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Continue</button></form><form id="code-step"><p>Enter the current code from your authenticator app.</p><label>Authenticator code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required></label><button type="submit">Verify and sign in</button></form><p id="result" role="status"></p></section></main><script>const login=document.getElementById('login-form'),codeForm=document.getElementById('code-step'),result=document.getElementById('result');async function post(path,data){const r=await fetch('/api/auth/'+path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(data)}),d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.message||d.error||'Sign in failed');return d}function go(user){location.href=user&&user.role==='ops'?'/app/ops':'/app'}login.addEventListener('submit',async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(login));try{const r=await post('sign-in/email',{...data,callbackURL:'/app'});if(r.twoFactorRedirect){login.style.display='none';codeForm.style.display='block';return}if(!r.user?.twoFactorEnabled){location.href='/app/setup-mfa';return}go(r.user)}catch(error){result.textContent='Email or password is incorrect, or sign-in is unavailable.'}});codeForm.addEventListener('submit',async e=>{e.preventDefault();try{const data=await post('two-factor/verify-totp',Object.fromEntries(new FormData(codeForm)));go(data.user)}catch(error){result.textContent='That code was not accepted. Check your authenticator and try again.'}});</script></body></html>`;

const mfaSetupPageHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authenticator setup · MKETY Campaigns</title><style>:root{font-family:Inter,system-ui,sans-serif;color:#10233f;background:#f5f8fc}*{box-sizing:border-box}body{margin:0}main{width:min(620px,calc(100% - 36px));margin:8vh auto}.panel{padding:24px;background:white;border:1px solid #e4eaf2;border-radius:14px}label{display:grid;gap:6px;margin:14px 0}input{padding:11px;border:1px solid #cbd6e4;border-radius:8px;font:inherit}button{border:0;border-radius:8px;padding:11px 15px;background:#006fff;color:white;font:inherit;font-weight:700;cursor:pointer}code,pre{overflow-wrap:anywhere;background:#f1f5fa;padding:12px;border-radius:8px}#verify-step{display:none}#result{color:#9a3b23;min-height:22px}</style></head><body><main><section class="panel"><a href="/">MKETY Campaigns</a><h1>Set up your authenticator app</h1><p>Two-factor authentication is required for every workspace. Enter your password to generate a setup key, add it to an authenticator app, save your backup codes, and verify one code.</p><form id="enable-form"><label>Account password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Start authenticator setup</button></form><section id="verify-step"><h2>1. Add this key in your authenticator</h2><p>Choose manual setup in your app and enter this key:</p><pre id="secret"></pre><h2>2. Save your backup codes</h2><pre id="backup"></pre><label><input id="saved" type="checkbox"> I saved these backup codes somewhere secure</label><form id="verify-form"><label>Current six-digit code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required></label><button type="submit">Verify authenticator and finish</button></form></section><p id="result" role="status"></p></section></main><script>const enable=document.getElementById('enable-form'),verify=document.getElementById('verify-form'),step=document.getElementById('verify-step'),result=document.getElementById('result');let password='';async function post(path,data){const r=await fetch('/api/auth/'+path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(data)}),d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.message||d.error||'Request failed');return d}enable.addEventListener('submit',async e=>{e.preventDefault();password=new FormData(enable).get('password');try{const d=await post('two-factor/enable',{password,method:'totp',issuer:'MKETY Campaigns'}),uri=new URL(d.totpURI),secret=uri.searchParams.get('secret');document.getElementById('secret').textContent=secret||'Could not read authenticator key';document.getElementById('backup').textContent=(d.backupCodes||[]).join('\n');enable.hidden=true;step.style.display='block'}catch(error){result.textContent='Could not start authenticator setup. Sign in again and check your password.'}});verify.addEventListener('submit',async e=>{e.preventDefault();if(!document.getElementById('saved').checked){result.textContent='Save the backup codes before continuing.';return}try{const d=await post('two-factor/verify-totp',Object.fromEntries(new FormData(verify)));location.href=d.user&&d.user.role==='ops'?'/app/ops':'/app'}catch(error){result.textContent='The code was not accepted. Check the code and try again.'}});</script></body></html>`;

const inviteAcceptPageHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Accept invitation · MKETY Campaigns</title><meta name="referrer" content="no-referrer"><style>:root{font-family:Inter,system-ui,sans-serif;color:#10233f;background:#f5f8fc}*{box-sizing:border-box}body{margin:0}main{width:min(480px,calc(100% - 36px));margin:12vh auto}.panel{padding:24px;background:white;border:1px solid #e4eaf2;border-radius:14px}label{display:grid;gap:6px;margin:14px 0}input{padding:11px;border:1px solid #cbd6e4;border-radius:8px;font:inherit}button{border:0;border-radius:8px;padding:11px 15px;background:#006fff;color:white;font:inherit;font-weight:700}#result{color:#9a3b23}</style></head><body><main><section class="panel"><h1>Set up your MKETY Campaigns account</h1><p>Use a password with at least 12 characters. You'll enroll an authenticator app before accessing the workspace.</p><form id="accept-form"><label>Your name<input name="displayName" maxlength="160" required></label><label>Password<input name="password" type="password" minlength="12" maxlength="128" required></label><button type="submit">Accept invitation</button></form><p id="result" role="status"></p></section></main><script>const form=document.getElementById('accept-form'),result=document.getElementById('result'),token=new URLSearchParams(location.search).get('token');history.replaceState(null,'',location.pathname);form.addEventListener('submit',async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(form));try{const r=await fetch('/api/invitations/accept',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...data,token})}),payload=await r.json();if(!r.ok)throw Error(payload.error);location.href='/login'}catch(error){result.textContent='This invite may have expired or already been used. Ask MKETY Ops for a new link.'}});</script></body></html>`;

function unsubscribePageHtml(token: string): string {
  const valid = /^[A-Za-z0-9_-]{40,64}$/.test(token);
  const hidden = valid ? `<input type="hidden" name="token" value="${token}">` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Email preferences · MKETY Campaigns</title><style>body{font:16px system-ui,sans-serif;color:#10233f;background:#f5f8fc;margin:0}main{width:min(480px,calc(100% - 36px));margin:12vh auto}.panel{background:white;border:1px solid #e4eaf2;border-radius:14px;padding:24px}button{background:#006fff;color:#fff;border:0;border-radius:8px;padding:12px 16px;font:inherit;font-weight:700;cursor:pointer}</style></head><body><main><section class="panel"><h1>Email preferences</h1>${valid ? `<p>Confirm that you want to stop receiving campaign emails from this sender.</p><form method="post" action="/unsubscribe">${hidden}<button type="submit">Unsubscribe</button></form>` : `<p>This unsubscribe link is invalid or expired.</p>`}</section></main></body></html>`;
}

function isTrustedMutationOrigin(request: Request, trustedOrigins?: string[]): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return true;
  if (!trustedOrigins?.length) return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return trustedOrigins.includes(new URL(origin).origin);
  } catch {
    return false;
  }
}
