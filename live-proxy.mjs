// Chained CONNECT forward proxy for the live-check sandbox.
// Listens on 127.0.0.1:18080, chains to the authenticated sandbox egress proxy.
import net from "node:net";

const UPSTREAM_HOST = "hatch-egress-proxy";
const UPSTREAM_PORT = 3128;
function proxyAuth() {
  const url = process.env.https_proxy || process.env.HTTPS_PROXY || "";
  const m = url.match(/^http:\/\/([^:]+):([^@]+)@/);
  return m ? "Basic " + Buffer.from(`${m[1]}:${m[2]}`).toString("base64") : "";
}

const server = net.createServer((client) => {
  const chunks = [];
  const onData = (chunk) => {
    chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    const endIdx = buf.indexOf("\r\n\r\n");
    if (endIdx === -1) return;
    client.removeListener("data", onData);
    const headerBuf = buf.subarray(0, endIdx);
    const rest = buf.subarray(endIdx + 4);
    const requestLine = headerBuf.toString("utf8").split("\r\n")[0];
    const [method, target] = requestLine.split(" ");
    if (method !== "CONNECT") {
      client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
      return;
    }
    // Chain: open CONNECT to the upstream egress proxy
    const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
      upstream.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${proxyAuth()}\r\n\r\n`,
      );
    });
    const ubuf = [];
    const onUpData = (chunk) => {
      ubuf.push(chunk);
      const b = Buffer.concat(ubuf);
      const i = b.indexOf("\r\n\r\n");
      if (i === -1) return;
      upstream.removeListener("data", onUpData);
      const statusLine = b.subarray(0, b.indexOf("\r\n")).toString("utf8");
      if (!statusLine.includes(" 200")) {
        client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        upstream.destroy();
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const uRest = b.subarray(i + 4);
      if (uRest.length) client.write(uRest);
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
    };
    upstream.on("data", onUpData);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  };
  client.on("data", onData);
  client.on("error", () => {});
});

server.listen(18080, "127.0.0.1", () => console.log("chained proxy on 127.0.0.1:18080"));
