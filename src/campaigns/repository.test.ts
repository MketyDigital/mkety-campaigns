import assert from "node:assert/strict";
import test from "node:test";
import { D1CampaignWorkspace } from "./repository.js";

test("D1 review maps decisions correctly and only audits a successful transition", async () => {
  const database = fakeD1({ updateChanges: 1 });
  const workspace = new D1CampaignWorkspace(database as unknown as D1Database);

  const result = await workspace.reviewCampaign("campaign-1", "ops-1", "reject");

  assert.equal(result?.status, "rejected");
  assert.equal(database.auditActions[0], "campaign_rejected");
  assert.match(database.auditSql, /WHERE changes\(\) > 0/);
});

test("D1 review returns no campaign and writes no audit when a concurrent review wins", async () => {
  const database = fakeD1({ updateChanges: 0 });
  const workspace = new D1CampaignWorkspace(database as unknown as D1Database);

  const result = await workspace.reviewCampaign("campaign-1", "ops-2", "approve");

  assert.equal(result, null);
  assert.deepEqual(database.auditActions, []);
});

function fakeD1(options: { updateChanges: number }) {
  const state = { auditActions: [] as string[], auditSql: "" };
  let lastSql = "";
  let lastValues: unknown[] = [];
  const database = {
    prepare(sql: string) {
      const statement = {
        sql,
        values: [] as unknown[],
        bind(...values: unknown[]) { this.values = values; return this; },
        async first<T>() {
          if (sql.includes("SELECT tenant_id FROM campaigns")) return { tenant_id: "tenant-1" } as T;
          if (sql.includes("SELECT id, tenant_id, channel")) return {
            id: "campaign-1", tenant_id: "tenant-1", channel: "email", status: "rejected",
            subject: "Hello", body_html: null, body_text: "Hi", created_at: "2026-11-02T12:00:00.000Z",
          } as T;
          return null;
        },
        async run() {
          lastSql = sql;
          lastValues = this.values;
          return { meta: { changes: sql.startsWith("UPDATE campaigns") ? options.updateChanges : 1 } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ sql: string; values: unknown[]; run: () => Promise<{ meta: { changes: number } }> }>) {
      const updateResult = await statements[0]!.run();
      const audit = statements[1]!;
      state.auditSql = audit.sql;
      if (updateResult.meta.changes > 0 && /WHERE changes\(\) > 0/.test(audit.sql)) state.auditActions.push(String(audit.values[3]));
      return [updateResult, { meta: { changes: state.auditActions.length } }];
    },
    get auditActions() { return state.auditActions; },
    get auditSql() { return state.auditSql || lastSql + JSON.stringify(lastValues); },
  };
  return database;
}
