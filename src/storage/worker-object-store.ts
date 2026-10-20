import type { ObjectStore } from "./object-store.js";

/** Cloudflare-native R2 access for the optional Workers deployment. */
export function createWorkerR2Store(bucket: R2Bucket): ObjectStore {
  return {
    name: "cloudflare-r2",
    async put(key, body, contentType) {
      await bucket.put(key, body, { httpMetadata: { contentType } });
    },
    async get(key) {
      const object = await bucket.get(key);
      if (!object) throw new Error(`cloudflare-r2: object ${key} was not found`);
      return { body: await object.arrayBuffer().then((buffer) => new Uint8Array(buffer)), contentType: object.httpMetadata?.contentType };
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}
