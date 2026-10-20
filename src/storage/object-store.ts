import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { BlobServiceClient } from "@azure/storage-blob";

export interface ObjectStore {
  readonly name: string;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; contentType?: string }>;
  delete(key: string): Promise<void>;
}

export type S3ObjectStoreConfig = {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export function createS3ObjectStore(config: S3ObjectStoreConfig): ObjectStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });

  return {
    name: config.name,
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key) {
      const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      if (!result.Body) throw new Error(`${config.name}: object ${key} has no body`);
      return { body: await result.Body.transformToByteArray(), contentType: result.ContentType };
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}

export function createAzureObjectStore(connectionString: string, containerName: string): ObjectStore {
  const container = BlobServiceClient.fromConnectionString(connectionString).getContainerClient(containerName);
  return {
    name: "azure-blob-backup",
    async put(key, body, contentType) {
      const blob = container.getBlockBlobClient(key);
      await blob.uploadData(body, { blobHTTPHeaders: { blobContentType: contentType } });
    },
    async get(key) {
      const blob = container.getBlobClient(key);
      const response = await blob.download();
      if (!response.readableStreamBody) throw new Error(`azure-blob-backup: object ${key} has no body`);
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.readableStreamBody) chunks.push(chunk as Uint8Array);
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      return { body, contentType: response.contentType };
    },
    async delete(key) {
      await container.deleteBlob(key);
    },
  };
}

export type BackupResult = { store: string; ok: true } | { store: string; ok: false; error: string };

/**
 * Replication is an explicit background action so routine request handling only
 * writes to R2. A durable job runner will call this service when archive/backup
 * work is scheduled; it must record failed targets and retry them idempotently.
 */
export async function replicateObject(
  primary: ObjectStore,
  secondaryStores: ObjectStore[],
  key: string,
): Promise<BackupResult[]> {
  const object = await primary.get(key);
  return Promise.all(secondaryStores.map(async (store): Promise<BackupResult> => {
    try {
      await store.put(key, object.body, object.contentType ?? "application/octet-stream");
      return { store: store.name, ok: true };
    } catch (error) {
      return { store: store.name, ok: false, error: error instanceof Error ? error.message : "unknown error" };
    }
  }));
}

export function createR2Store(env: NodeJS.ProcessEnv): ObjectStore {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    throw new Error("R2 account, credentials, and bucket must be configured");
  }
  return createS3ObjectStore({
    name: "cloudflare-r2",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    region: "auto",
    bucket: R2_BUCKET,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  });
}

export function createOciArchiveStore(env: NodeJS.ProcessEnv): ObjectStore {
  const { OCI_OBJECT_STORAGE_ENDPOINT, OCI_OBJECT_STORAGE_REGION, OCI_OBJECT_STORAGE_ACCESS_KEY_ID, OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY, OCI_OBJECT_STORAGE_BUCKET } = env;
  if (!OCI_OBJECT_STORAGE_ENDPOINT || !OCI_OBJECT_STORAGE_REGION || !OCI_OBJECT_STORAGE_ACCESS_KEY_ID || !OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY || !OCI_OBJECT_STORAGE_BUCKET) {
    throw new Error("OCI endpoint, region, credentials, and bucket must be configured");
  }
  return createS3ObjectStore({
    name: "oci-infrequent-access",
    endpoint: OCI_OBJECT_STORAGE_ENDPOINT,
    region: OCI_OBJECT_STORAGE_REGION,
    bucket: OCI_OBJECT_STORAGE_BUCKET,
    accessKeyId: OCI_OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY,
  });
}

export function createAzureBackupStore(env: NodeJS.ProcessEnv): ObjectStore {
  if (!env.AZURE_STORAGE_CONNECTION_STRING || !env.AZURE_STORAGE_CONTAINER) {
    throw new Error("Azure Storage connection string and container must be configured");
  }
  return createAzureObjectStore(env.AZURE_STORAGE_CONNECTION_STRING, env.AZURE_STORAGE_CONTAINER);
}
