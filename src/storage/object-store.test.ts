import assert from "node:assert/strict";
import test from "node:test";
import type { ObjectStore } from "./object-store.js";
import { createOptionalBackupStores, replicateObject } from "./object-store.js";

test("backup targets stay disabled when their credentials are absent", () => {
  assert.deepEqual(createOptionalBackupStores({}), []);
});

test("partial optional backup configuration fails visibly", () => {
  assert.throws(
    () => createOptionalBackupStores({ OCI_OBJECT_STORAGE_REGION: "eu-frankfurt-1" }),
    /OCI backup storage is partially configured/,
  );
});

test("replication reports each backup result independently", async () => {
  const primary: ObjectStore = {
    name: "r2",
    async get() { return { body: new Uint8Array([1, 2, 3]), contentType: "text/csv" }; },
    async put() {}, async delete() {},
  };
  const good: ObjectStore = { name: "oci", async put() {}, async get() { return { body: new Uint8Array() }; }, async delete() {} };
  const bad: ObjectStore = { name: "azure", async put() { throw new Error("unavailable"); }, async get() { return { body: new Uint8Array() }; }, async delete() {} };
  const result = await replicateObject(primary, [good, bad], "tenant-1/exports/list.csv");
  assert.deepEqual(result, [
    { store: "oci", ok: true },
    { store: "azure", ok: false, error: "unavailable" },
  ]);
});
