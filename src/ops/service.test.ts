import assert from "node:assert/strict";
import test from "node:test";
import { PostgresOperationsService } from "./service.js";
import type { PostgresPool } from "../campaigns/repository.js";

type Call={sql:string;params:unknown[]};
function fakePool(calls:Call[]):PostgresPool {
  const client={
    query:async <T=Record<string,unknown>>(sql:string,params:unknown[]=[]):Promise<{rows:T[]}>=>{
      calls.push({sql,params});
      if(/^SELECT id FROM users/.test(sql)||/^SELECT id FROM tenant_invites/.test(sql))return {rows:[]};
      return {rows:[]};
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
