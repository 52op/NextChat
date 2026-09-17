import { NextRequest, NextResponse } from "next/server";
import { getServerSideConfig } from "@/app/config/server";
import { auth } from "@/app/api/auth";
import { ModelProvider } from "@/app/constant";

const config = getServerSideConfig();

// ---- serialized sync queue ----
// Same as the webdav route: run sync requests one at a time so concurrent
// devices cannot corrupt the shared remote state (write fully visible before
// the next read). Assumes a single server process.
let syncQueue: Promise<unknown> = Promise.resolve();

function enqueueSync<T>(task: () => Promise<T>): Promise<T> {
  const run = syncQueue.then(task, task);
  syncQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function handle(
  req: NextRequest,
  { params }: { params: { action: string; key: string[] } },
) {
  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }
  return enqueueSync(() => doHandle(req, params));
}

async function doHandle(
  req: NextRequest,
  params: { action: string; key: string[] },
) {
  const requestUrl = new URL(req.url);

  const authResult = auth(req, ModelProvider.GPT);
  if (authResult.error) {
    return NextResponse.json(authResult, { status: 401 });
  }

  const isServerManaged = config.serverSync.provider === "upstash";

  const endpoint =
    requestUrl.searchParams.get("endpoint") ??
    (isServerManaged ? config.serverSync.upstash.endpoint : null);

  const [...key] = params.key;
  // only allow to request to *.upstash.io
  if (!endpoint || !new URL(endpoint).hostname.endsWith(".upstash.io")) {
    return NextResponse.json(
      {
        error: true,
        msg: "you are not allowed to request " + params.key.join("/"),
      },
      {
        status: 403,
      },
    );
  }

  // only allow upstash get and set method
  if (params.action !== "get" && params.action !== "set") {
    console.log("[Upstash Route] forbidden action ", params.action);
    return NextResponse.json(
      {
        error: true,
        msg: "you are not allowed to request " + params.action,
      },
      {
        status: 403,
      },
    );
  }

  const targetUrl = `${endpoint}/${params.action}/${params.key.join("/")}`;

  const method = req.method;
  const shouldNotHaveBody = ["get", "head"].includes(
    method?.toLowerCase() ?? "",
  );

  // when server side sync is enabled, always use the server side upstash token.
  // the incoming authorization header only carries the access code for auth().
  let authorization = req.headers.get("authorization") ?? "";
  if (isServerManaged) {
    authorization = `Bearer ${config.serverSync.upstash.apiKey}`;
  }

  const fetchOptions: RequestInit = {
    headers: {
      authorization,
    },
    body: shouldNotHaveBody ? null : req.body,
    method,
    // @ts-ignore
    duplex: "half",
  };

  console.log("[Upstash Proxy]", targetUrl, fetchOptions);
  const fetchResult = await fetch(targetUrl, fetchOptions);

  console.log("[Any Proxy]", targetUrl, {
    status: fetchResult.status,
    statusText: fetchResult.statusText,
  });

  // never serve sync data from a browser HTTP cache (see webdav route)
  const newHeaders = new Headers(fetchResult.headers);
  newHeaders.set("Cache-Control", "no-store");
  newHeaders.set("Pragma", "no-cache");

  return new Response(fetchResult.body, {
    status: fetchResult.status,
    statusText: fetchResult.statusText,
    headers: newHeaders,
  });
}

export const POST = handle;
export const GET = handle;
export const OPTIONS = handle;

export const runtime = "edge";
