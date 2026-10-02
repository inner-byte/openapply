import { createWorkerServer } from "./server.ts";

const token = process.env.WORKER_TOKEN ?? "";
const worker = await createWorkerServer({
  token,
  dataDir: process.env.WORKER_DATA_DIR ?? ".openapply/browser-profiles",
  maxSessions: 3,
  idleTimeoutMs: 30 * 60_000,
  packDir: process.env.WORKER_PACK_DIR,
  upstreamProxy: process.env.WORKER_UPSTREAM_PROXY,
});
worker.server.listen(8790, process.env.WORKER_HOST ?? "127.0.0.1", () => {
  console.log("OpenApply browser worker listening on port 8790");
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 30_000);
  deadline.unref();
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
