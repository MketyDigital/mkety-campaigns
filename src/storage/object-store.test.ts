import assert from "node:assert/strict";
import test from "node:test";
import type { ObjectStore } from "./object-store.js";
import { createOptionalBackupStores, replicateObject } from "./object-store.js";

test("backup targets stay disabled when their credentials are absent", () => {
  assert.deepEqual(createOptionalBackupStores({}), []);
});

test("OCI backup stays off when credentials exist but the feature flag is absent", () => {
  const stores = createOptionalBackupStores({
    OCI_OBJECT_STORAGE_ENDPOINT: "https://namespace.compat.objectstorage.eu-frankfurt-1.oci.customer-oci.com",
    OCI_OBJECT_STORAGE_REGION: "eu-frankfurt-1",
    OCI_OBJECT_STORAGE_ACCESS_KEY_ID: "access",
    OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
    OCI_OBJECT_STORAGE_BUCKET: "mkety-central-backups",
  });
  assert.deepEqual(stores, []);
});

test("OCI backup rejects partial settings only after explicit enablement", () => {
  assert.throws(
    () => createOptionalBackupStores({ OCI_BACKUP_ENABLED: "true", OCI_BACKUP_RETENTION_DAYS: "31", OCI_OBJECT_STORAGE_REGION: "eu-frankfurt-1" }),
    /OCI backup storage is partially configured/,
  );
});

test("OCI backup cannot be enabled without at least 31 days retention", () => {
  assert.throws(
    () => createOptionalBackupStores({ OCI_BACKUP_ENABLED: "true" }),
    /OCI_BACKUP_RETENTION_DAYS must be at least 31/,
  );
});

test("OCI backup becomes available only after explicit enablement and full configuration", () => {
  const stores = createOptionalBackupStores({
    OCI_BACKUP_ENABLED: "true",
    OCI_BACKUP_RETENTION_DAYS: "31",
    OCI_OBJECT_STORAGE_ENDPOINT: "https://namespace.compat.objectstorage.eu-frankfurt-1.oci.customer-oci.com",
    OCI_OBJECT_STORAGE_REGION: "eu-frankfurt-1",
    OCI_OBJECT_STORAGE_ACCESS_KEY_ID: "access",
    OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
    OCI_OBJECT_STORAGE_BUCKET: "mkety-central-backups",
  });
  assert.deepEqual(stores.map((store) => store.name), ["oci-infrequent-access"]);
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
