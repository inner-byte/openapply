import { once } from "node:events";
import { createServer, type OutgoingHttpHeaders, request } from "node:http";
import { connect, type Socket } from "node:net";
import { validatePublicUrl } from "./network.ts";

export interface UpstreamProxy {
  host: string;
  port: number;
  authorization?: string;
}

export function parseUpstreamProxy(raw: string | undefined): UpstreamProxy | null {
  if (!raw?.trim()) return null;
  const url = new URL(raw.trim());
  if (url.protocol !== "http:")
    throw new Error("WORKER_UPSTREAM_PROXY must be an http:// proxy URL.");
  const authorization =
    url.username || url.password
      ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`
      : undefined;
  return {
    host: url.hostname,
    port: Number(url.port || 3128),
    authorization,
  };
}

/** All upstream sockets connect to a validated IP, never a second DNS lookup. */
export async function startEgressProxy(upstream: UpstreamProxy | null = null) {
  const sockets = new Set<Socket>();
  // When chained through a trusted upstream proxy, the proxy resolves DNS;
  // the worker still validates scheme, hostname, and port.
  const validateOptions = upstream ? { skipIpCheck: true } : {};
  const withProxyAuth = (headers: OutgoingHttpHeaders): OutgoingHttpHeaders =>
    upstream?.authorization
      ? { ...headers, "proxy-authorization": upstream.authorization }
      : headers;

  /** CONNECT through the upstream proxy to host:443, resolving via the proxy. */
  function connectViaUpstream(host: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      if (!upstream) return reject(new Error("No upstream proxy configured."));
      const socket = connect({ host: upstream.host, port: upstream.port });
      sockets.add(socket);
      socket.setTimeout(30_000, () => {
        socket.destroy();
        reject(new Error("Upstream proxy connect timed out."));
      });
      let buffer = "";
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("latin1");
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        socket.off("data", onData);
        if (!/^HTTP\/1\.[01] 200\b/.test(buffer)) {
          socket.destroy();
          reject(new Error("Upstream proxy refused the tunnel."));
          return;
        }
        const leftover = Buffer.from(buffer.slice(end + 4), "latin1");
        socket.setTimeout(60_000, () => socket.destroy());
        if (leftover.length) socket.unshift(leftover);
        resolve(socket);
      };
      socket.on("data", onData);
      socket.on("error", reject);
      socket.on("close", () => {
        sockets.delete(socket);
        reject(new Error("Upstream proxy connection closed."));
      });
      socket.once("connect", () => {
        const auth = upstream.authorization
          ? `Proxy-Authorization: ${upstream.authorization}\r\n`
          : "";
        socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n${auth}\r\n`);
      });
    });
  }
  const server = createServer(async (incoming, response) => {
    try {
      const target = await validatePublicUrl(incoming.url ?? "", undefined, validateOptions);
      if (target.url.protocol !== "http:") throw new Error("HTTP proxy requires HTTP URL");
      const headers: OutgoingHttpHeaders = withProxyAuth({
        ...incoming.headers,
        host: target.url.host,
      });
      delete headers["proxy-connection"];
      const absolute = `${target.url.protocol}//${target.url.host}${target.url.pathname}${target.url.search}`;
      const upstreamRequest = upstream
        ? // Chain: send the absolute URI to the upstream proxy.
          request(
            {
              hostname: upstream.host,
              port: upstream.port,
              path: absolute,
              method: incoming.method,
              headers,
              timeout: 30_000,
              agent: false,
            },
            (result) => {
              response.writeHead(result.statusCode ?? 502, result.headers);
              result.on("error", () => response.destroy());
              result.pipe(response);
            },
          )
        : request(
            {
              hostname: target.address,
              family: target.family,
              port: Number(target.url.port || 80),
              path: `${target.url.pathname}${target.url.search}`,
              method: incoming.method,
              headers,
              timeout: 30_000,
              agent: false,
            },
            (result) => {
              response.writeHead(result.statusCode ?? 502, result.headers);
              result.on("error", () => response.destroy());
              result.pipe(response);
            },
          );
      const forward = (req: ReturnType<typeof request>) => {
        req.on("timeout", () => req.destroy());
        req.on("error", () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        incoming.on("aborted", () => req.destroy());
        response.on("close", () => req.destroy());
        incoming.pipe(req);
      };
      forward(upstreamRequest);
    } catch {
      response.writeHead(403);
      response.end("Destination blocked");
    }
  });
  server.on("connect", async (request, client, head) => {
    client.on("error", () => client.destroy());
    try {
      const authority = request.url ?? "";
      if (!/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):443$/i.test(authority))
        throw new Error("Invalid tunnel");
      const target = await validatePublicUrl(`https://${authority}`, undefined, validateOptions);
      if (client.destroyed) return;
      // Use the validated hostname (not the filtered local IP) so the upstream
      // proxy resolves the real destination itself.
      const tunnelHost = upstream ? target.url.hostname : target.address;
      const openTunnel = async (): Promise<Socket> => {
        if (!upstream) {
          const direct = connect({ host: target.address, port: 443, family: target.family });
          sockets.add(direct);
          direct.setTimeout(60_000, () => direct.destroy());
          await once(direct, "connect");
          return direct;
        }
        return connectViaUpstream(tunnelHost);
      };
      const upstreamSocket = await openTunnel();
      const done = () => {
        sockets.delete(upstreamSocket);
        client.destroy();
      };
      upstreamSocket.on("close", done);
      upstreamSocket.on("error", () => client.destroy());
      client.on("close", () => upstreamSocket.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(client);
      client.pipe(upstreamSocket);
    } catch {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy unavailable");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
