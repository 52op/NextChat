import { NextRequest, NextResponse } from "next/server";
import { STORAGE_KEY, internalAllowedWebDavEndpoints } from "../../../constant";
import { getServerSideConfig } from "@/app/config/server";
import { auth } from "@/app/api/auth";
import { ModelProvider } from "@/app/constant";

const config = getServerSideConfig();

const mergedAllowedWebDavEndpoints = [
  ...internalAllowedWebDavEndpoints,
  ...config.allowedWebDavEndpoints,
].filter((domain) => Boolean(domain.trim()));

const normalizeUrl = (url: string) => {
  try {
    return new URL(url);
  } catch (err) {
    return null;
  }
};

// ---- serialized sync queue ----
// All sync requests funnel through this single NextChat instance, so we can
// prevent concurrent read/write races on the shared backup file by running
// them one after another. A client that writes first is fully visible to the
// next client before it reads, so concurrent devices merge instead of
// clobbering each other. (Assumes a single server process.)
let syncQueue: Promise<unknown> = Promise.resolve();

function enqueueSync<T>(task: () => Promise<T>): Promise<T> {
  const run = syncQueue.then(task, task);
  // keep the chain alive even when a task rejects
  syncQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function handle(
  req: NextRequest,
  { params }: { params: { path: string[] } },
) {
  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }
  return enqueueSync(() => doHandle(req, params));
}

async function doHandle(req: NextRequest, params: { path: string[] }) {
  const folder = STORAGE_KEY;
  const fileName = `${folder}/backup.json`;

  const authResult = auth(req, ModelProvider.GPT);
  if (authResult.error) {
    return NextResponse.json(authResult, { status: 401 });
  }

  const isServerManaged = config.serverSync.provider === "webdav";

  const requestUrl = new URL(req.url);
  let endpoint =
    requestUrl.searchParams.get("endpoint") ??
    (isServerManaged ? config.serverSync.webdav.endpoint : null);
  let proxy_method = requestUrl.searchParams.get("proxy_method") || req.method;

  // Validate the endpoint to prevent potential SSRF attacks
  if (
    !endpoint ||
    !mergedAllowedWebDavEndpoints.some((allowedEndpoint) => {
      const normalizedAllowedEndpoint = normalizeUrl(allowedEndpoint);
      const normalizedEndpoint = normalizeUrl(endpoint as string);

      return (
        normalizedEndpoint &&
        normalizedEndpoint.hostname === normalizedAllowedEndpoint?.hostname &&
        normalizedEndpoint.pathname.startsWith(
          normalizedAllowedEndpoint.pathname,
        )
      );
    })
  ) {
    return NextResponse.json(
      {
        error: true,
        msg: "Invalid endpoint",
      },
      {
        status: 400,
      },
    );
  }

  if (!endpoint?.endsWith("/")) {
    endpoint += "/";
  }

  const endpointPath = params.path.join("/");
  const targetPath = `${endpoint}${endpointPath}`;

  // only allow MKCOL, GET, PUT
  if (
    proxy_method !== "MKCOL" &&
    proxy_method !== "GET" &&
    proxy_method !== "PUT"
  ) {
    return NextResponse.json(
      {
        error: true,
        msg: "you are not allowed to request " + targetPath,
      },
      {
        status: 403,
      },
    );
  }

  // for MKCOL request, only allow request ${folder}
  if (proxy_method === "MKCOL" && !targetPath.endsWith(folder)) {
    return NextResponse.json(
      {
        error: true,
        msg: "you are not allowed to request " + targetPath,
      },
      {
        status: 403,
      },
    );
  }

  // for GET request, only allow request ending with fileName
  if (proxy_method === "GET" && !targetPath.endsWith(fileName)) {
    return NextResponse.json(
      {
        error: true,
        msg: "you are not allowed to request " + targetPath,
      },
      {
        status: 403,
      },
    );
  }

  //   for PUT request, only allow request ending with fileName
  if (proxy_method === "PUT" && !targetPath.endsWith(fileName)) {
    return NextResponse.json(
      {
        error: true,
        msg: "you are not allowed to request " + targetPath,
      },
      {
        status: 403,
      },
    );
  }

  const targetUrl = targetPath;

  const method = proxy_method || req.method;
  const shouldNotHaveBody = ["get", "head"].includes(
    method?.toLowerCase() ?? "",
  );

  // when server side sync is enabled, always use the server side webdav
  // credentials. the incoming authorization header only carries the access code
  // for auth() and must not be forwarded to the webdav server.
  let authorization = req.headers.get("authorization") ?? "";
  if (isServerManaged) {
    const { username, password } = config.serverSync.webdav;
    authorization = `Basic ${btoa(username + ":" + password)}`;
  }

  const fetchOptions: RequestInit = {
    headers: {
      authorization,
    },
    body: shouldNotHaveBody ? null : req.body,
    redirect: "manual",
    method,
    // @ts-ignore
    duplex: "half",
  };

  let fetchResult;

  try {
    fetchResult = await fetch(targetUrl, fetchOptions);
  } finally {
    console.log(
      "[Any Proxy]",
      targetUrl,
      {
        method: method,
      },
      {
        status: fetchResult?.status,
        statusText: fetchResult?.statusText,
      },
    );
  }

  // The sync backup must never be served from a browser HTTP cache: a cached
  // stale/truncated response would be merged into local state silently. Force
  // no-store on everything we return to the client.
  const newHeaders = new Headers(fetchResult.headers);
  newHeaders.set("Cache-Control", "no-store");
  newHeaders.set("Pragma", "no-cache");

  return new Response(fetchResult.body, {
    status: fetchResult.status,
    statusText: fetchResult.statusText,
    headers: newHeaders,
  });
}

export const PUT = handle;
export const GET = handle;
export const OPTIONS = handle;

export const runtime = "edge";
