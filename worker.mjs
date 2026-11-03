import { DurableObject } from "cloudflare:workers";

const port = 3000;
const inactivityTimeout = 2 * 60 * 60 * 1000;
const containerEnvironmentKeys = [
  "CHATTER_ICE_SERVERS",
  "CHATTER_MODERATOR_PASSWORD",
  "CHATTER_PUBLIC_URL",
  "BREVO_API_KEY",
  "BREVO_SENDER_EMAIL",
  "BREVO_SENDER_NAME",
  "PAYSTACK_PLAN_CODE",
  "PAYSTACK_SECRET_KEY",
  "SUPABASE_PROJECT_ID",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_URL"
];

export class ChatterBackend extends DurableObject {
  starting;

  async fetch(request) {
    this.starting ??= this.startAndWaitForPort().finally(() => {
      this.starting = undefined;
    });
    await this.starting;

    const url = new URL(request.url);
    url.protocol = "http:";
    url.host = "container";
    const forwarded = new Request(url, request);
    forwarded.headers.delete("host");
    return this.ctx.container.getTcpPort(port).fetch(forwarded);
  }

  async startAndWaitForPort() {
    const container = this.ctx.container;
    if (!container.running) {
      if (!this.env.SUPABASE_PROJECT_ID || !this.env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("Configure SUPABASE_PROJECT_ID and SUPABASE_SERVICE_ROLE_KEY as Worker secrets.");
      }

      const env = Object.fromEntries(
        containerEnvironmentKeys
          .map((key) => [key, this.env[key]])
          .filter((entry) => typeof entry[1] === "string" && entry[1].length > 0)
      );
      Object.assign(env, { HOST: "0.0.0.0", NODE_ENV: "production", PORT: String(port) });
      container.start({
        image: container.images.base,
        instance: "lite",
        enableInternet: true,
        env
      });
    }
    await container.setInactivityTimeout(inactivityTimeout);

    const containerPort = container.getTcpPort(port);
    let lastError;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await containerPort.fetch("http://container/", {
          signal: AbortSignal.timeout(1000)
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`Health check returned ${response.status}`);
        return;
      } catch (error) {
        lastError = error;
        await scheduler.wait(200);
      }
    }
    throw new Error(`Chatter container did not become ready on port ${port}.`, { cause: lastError });
  }
}

export default {
  fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return env.CHATTER_BACKEND.getByName("chatterr-production").fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
