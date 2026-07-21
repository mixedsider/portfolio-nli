import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8"
};

export function createStaticServer(options = {}) {
  const root = resolve(options.root || process.cwd());

  return createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "Method Not Allowed", { Allow: "GET, HEAD" });
      return;
    }

    const pathResult = resolveStaticPath(root, request.url || "/");
    if (!pathResult.ok) {
      sendText(response, pathResult.statusCode, pathResult.message);
      return;
    }

    try {
      const body = await readFile(pathResult.filePath);
      response.writeHead(200, {
        "Content-Type": contentTypes[extname(pathResult.filePath)]
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      sendText(response, 404, "Not found");
    }
  });
}

export function resolveStaticPath(root, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
  } catch {
    return { ok: false, statusCode: 400, message: "Bad request" };
  }

  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const rootPath = resolve(root);
  const filePath = resolve(rootPath, `.${requestedPath}`);
  const relativePath = relative(rootPath, filePath);

  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return { ok: false, statusCode: 403, message: "Forbidden" };
  }
  if (relativePath.split(/[\\/]/).some((segment) => segment.startsWith("."))) {
    return { ok: false, statusCode: 404, message: "Not found" };
  }
  if (!Object.hasOwn(contentTypes, extname(filePath))) {
    return { ok: false, statusCode: 404, message: "Not found" };
  }

  return { ok: true, filePath };
}

function sendText(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  response.end(body);
}

const isDirectExecution =
  typeof process !== "undefined" && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const root = resolve(process.cwd());
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || "127.0.0.1";
  const server = createStaticServer({ root });

  server.listen(port, host, () => {
    console.log(`Serving ${root} at http://${host}:${port}`);
  });
}
