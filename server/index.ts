import { buildApp } from "./api/server.js";

const PORT = Number(process.env.PORT ?? 4310);
// All API endpoints bind to localhost only by default (spec section 9).
const HOST = process.env.OMNIDISK_ALLOW_EXTERNAL === "1" ? "0.0.0.0" : "127.0.0.1";

async function main(): Promise<void> {
  const { app } = await buildApp({
    allowExternalNetwork: process.env.OMNIDISK_ALLOW_EXTERNAL === "1",
  });

  if (HOST === "0.0.0.0") {
    app.log.warn(
      "OMNIDISK_ALLOW_EXTERNAL=1 — binding to 0.0.0.0. This exposes the API " +
        "beyond localhost with no auth layer built for it yet. Do not enable " +
        "this on an untrusted network.",
    );
  }

  await app.listen({ port: PORT, host: HOST });
  // Deliberately plain console.log (not app.log.info) so this line is easy
  // to grep for from an external launcher script — e.g. the Colab runner
  // waits on this exact prefix to know the server is ready before asking
  // Colab for a public proxy URL.
  console.log(`OmniDisk listening on http://${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error("Fatal error starting OmniDisk server:", err);
  process.exit(1);
});
