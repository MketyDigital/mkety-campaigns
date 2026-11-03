export function createOpaqueUnsubscribeToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function buildUnsubscribeUrl(baseUrl: string, token: string): URL {
  const url = new URL("/unsubscribe", baseUrl);
  if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error("Unsubscribe URL must use HTTPS outside localhost");
  url.searchParams.set("token", token);
  return url;
}
