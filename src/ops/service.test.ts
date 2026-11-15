import assert from "node:assert/strict";
import test from "node:test";
import { PostgresOperationsService } from "./service.js";
import type { PostgresPool } from "../campaigns/repository.js";

type Call={sql:string;params:unknown[]};
function fakePool(calls:Call[], resultRows:Record<string,unknown>[] = [], followingResults:Record<string,unknown>[][] = []):PostgresPool {
  let resultIndex=0;
  const client={
    query:async <T=Record<string,unknown>>(sql:string,params:unknown[]=[]):Promise<{rows:T[]}>=>{
      calls.push({sql,params});
      if(/^SELECT id FROM users/.test(sql)||/^SELECT id FROM tenant_invites/.test(sql))return {rows:[]};
      const rows=resultIndex===0?resultRows:(followingResults[resultIndex-1]??[]);resultIndex++;
      return {rows:rows as T[]};
    },
    release:()=>{},
  };
  return {query:client.query,connect:async()=>client};
}

test("workspace invite stores only a token hash and audits the authenticated Ops actor",async()=>{
  const calls:Call[]=[];
  const service=new PostgresOperationsService(fakePool(calls),"https://campaign.mkety.com");
  const result=await service.createTenantInvite("Acme","Owner@Example.com",{
    plan:"growth",contractReference:"AGR-42",contractStartedAt:"2026-11-01T00:00:00.000Z",
    expiresAt:"2027-11-01T00:00:00.000Z",maxCampaignRecipients:75,maxDailyEmailRecipients:500,
  },"8a6d6b31-ea73-4fd4-b05b-568b40d7a819");
  const token=new URL(result.inviteUrl).searchParams.get("token");
  assert.ok(token && token.length>=40);
  const tenant=calls.find(call=>call.sql.startsWith("INSERT INTO tenants"));
  assert.ok(tenant);
  assert.deepEqual(tenant.params.slice(1),[
    "Acme","growth","AGR-42","2026-11-01T00:00:00.000Z","2027-11-01T00:00:00.000Z",75,500,
  ]);
  const audit=calls.find(call=>call.sql.includes("'workspace_created'"));
  assert.equal(audit?.params[0],"8a6d6b31-ea73-4fd4-b05b-568b40d7a819");
  const invite=calls.find(call=>call.sql.includes("INSERT INTO tenant_invites"));
  assert.ok(invite);
  assert.notEqual(invite.params[3],token);
  assert.equal(calls.at(-1)?.sql,"COMMIT");
});

test("workspace provisioning rejects recipient limits above the enforced ceiling",async()=>{
  const calls:Call[]=[];
  const service=new PostgresOperationsService(fakePool(calls),"https://campaign.mkety.com");
  await assert.rejects(()=>service.createTenantInvite("Acme","owner@example.com",{maxCampaignRecipients:1001}));
  assert.equal(calls.some(call=>call.sql.startsWith("INSERT INTO tenants")),false);
  assert.equal(calls.at(-1)?.sql,"ROLLBACK");
});


test("Ops tenant overview is aggregate-only and scoped to one tenant and allowed window",async()=>{
  const calls:Call[]=[];
  const service=new PostgresOperationsService(fakePool(calls,[{
    workspace_id:"tenant-1",contact_count:14,email_consented:9,sms_consented:3,
    email_suppressed:2,sms_suppressed:1,
    campaign_statuses:[{status:"approved",count:2}],
    delivery_statuses:[{channel:"email",status:"delivered",count:7}],
  }]),"https://campaign.mkety.com");
  const overview=await service.getWorkspaceOverview?.("tenant-1",30);
  assert.ok(overview);
  assert.deepEqual(overview.contacts,{total:14,emailConsented:9,smsConsented:3,emailSuppressed:2,smsSuppressed:1});
  assert.deepEqual(overview.campaignsByStatus,[{status:"approved",count:2}]);
  assert.deepEqual(overview.deliveryByChannelStatus,[{channel:"email",status:"delivered",count:7}]);
  assert.deepEqual(overview.domainReadiness,{total:2,ready:1,pending:1});
  assert.deepEqual(overview.senderReadiness,{total:2,ready:1,pending:1});
  const query=calls[0];
  assert.ok(query);
  assert.deepEqual(query.params,["tenant-1",30]);
  assert.match(query.sql,/WHERE t\.id=\$1/);
  assert.match(query.sql,/tenant_id=t\.id/);
  assert.doesNotMatch(query.sql,/contacts\.(email|phone_e164|display_name)/i);
});


test("Ops tenant readiness counts verified domains and ready senders without returning identifiers or DNS material",async()=>{
  const calls:Call[]=[];
  const domains=[
    {provisioning_state:"Succeeded",linked:true,verification_records_json:'{"spf":{"token":"dns-secret"}}',verification_states_json:'{"spf":{"status":"Verified"}}'},
    {provisioning_state:"Succeeded",linked:false,verification_records_json:'{"dkim":{"token":"other-secret"}}',verification_states_json:'{"dkim":{"status":"Pending"}}'},
  ];
  const service=new PostgresOperationsService(fakePool(calls,[{
    workspace_id:"tenant-1",contact_count:0,email_consented:0,sms_consented:0,email_suppressed:0,sms_suppressed:0,
    campaign_statuses:[],delivery_statuses:[],
  }],[domains,[{status:"ready",count:"1"},{status:"pending",count:"1"}]]),"https://campaign.mkety.com");
  const overview=await service.getWorkspaceOverview?.("tenant-1",7);
  assert.ok(overview);
  assert.deepEqual(overview.domainReadiness,{total:2,ready:1,pending:1});
  assert.deepEqual(overview.senderReadiness,{total:2,ready:1,pending:1});
  const serialized=JSON.stringify(overview);
  assert.doesNotMatch(serialized,/dns-secret|other-secret|domain_name|sender_address/i);
  assert.match(calls[1]?.sql??"",/tenant_id=\$1/);
  assert.doesNotMatch(calls[1]?.sql??"",/domain_name|verification_records_json/);
  assert.match(calls[2]?.sql??"",/tenant_id=\$1/);
  assert.doesNotMatch(calls[2]?.sql??"",/sender_address|display_name/i);
});

test("Ops tenant overview rejects unapproved reporting windows",async()=>{
  const calls:Call[]=[];
  const service=new PostgresOperationsService(fakePool(calls),"https://campaign.mkety.com");
  await assert.rejects(()=>service.getWorkspaceOverview?.("tenant-1",365),/reporting window/i);
  assert.equal(calls.length,0);
});
