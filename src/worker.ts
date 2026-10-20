import { createApp } from "./app.js";

export default {
  fetch(request: Request, env: { DB: D1Database }): Response | Promise<Response> {
    const app = createApp(async () => {
      try {
        await env.DB.prepare("SELECT 1").first();
        return true;
      } catch {
        return false;
      }
    });
    return app.fetch(request, env);
  },
};
