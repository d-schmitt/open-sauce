// Standalone launcher: the same UI and backend as the canvas, without the Copilot SDK.
import { createRuntime } from "./runtime.mjs";
import { APP_NAME } from "./model.mjs";

const runtime = await createRuntime();
const server = await runtime.open("standalone", { port: Number(process.env.PORT || 0) });
const info = runtime.info();
console.log(`${APP_NAME}: ${server.url}`);
console.log(info.configured ? `Cookbook folder: ${info.dataDir}` : "No cookbook configured yet: open the URL to set one up.");
console.log("Keep this URL private; it contains the access token. Press Ctrl+C to stop.");
// Only the file location is printed. The agent token stays in that 0600 file.
if (info.agent.running) console.log(`Local AI assistants can submit drafts to this instance (${info.agent.instanceId}); its address and token are in: ${info.agent.file}`);
else if (info.agent.error) console.log(info.agent.error);
const close = async () => { await runtime.dispose(); process.exit(0); };
process.once("SIGINT", close);
process.once("SIGTERM", close);
