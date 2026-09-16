import { NextRequest, NextResponse } from "next/server";
import { getServerSideConfig } from "@/app/config/server";
import { auth } from "@/app/api/auth";
import { ModelProvider } from "@/app/constant";
import { transcribePcm } from "@/app/utils/iflytek-asr";

// vercel hobby: node runtime can run up to 60s
export const runtime = "nodejs";
export const maxDuration = 60;

const serverConfig = getServerSideConfig();

async function handle(req: NextRequest) {
  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }

  const authResult = auth(req, ModelProvider.GPT);
  if (authResult.error) {
    return NextResponse.json(authResult, { status: 401 });
  }

  if (!serverConfig.isIflytekAsrEnabled) {
    return NextResponse.json(
      { error: true, msg: "IFLYTEK ASR is not configured on the server" },
      { status: 400 },
    );
  }

  // accept raw pcm (16k/16bit/mono) or wav
  const buffer = Buffer.from(await req.arrayBuffer());

  // strip wav header if present
  let pcm = buffer;
  if (buffer.length > 12 && buffer.toString("ascii", 0, 4) === "RIFF") {
    // find data chunk
    let off = 12;
    while (off < buffer.length) {
      const id = buffer.toString("ascii", off, off + 4);
      const sz = buffer.readUInt32LE(off + 4);
      if (id === "data") {
        pcm = buffer.subarray(off + 8, off + 8 + sz);
        break;
      }
      off += 8 + sz;
    }
  }

  if (pcm.length === 0) {
    return NextResponse.json(
      { error: true, msg: "empty audio" },
      { status: 400 },
    );
  }

  // roughly 16k mono 16bit => seconds
  const seconds = pcm.length / 16000 / 2;
  if (seconds > 40) {
    return NextResponse.json(
      { error: true, msg: `audio too long: ${Math.round(seconds)}s, max 40s` },
      { status: 400 },
    );
  }

  try {
    const text = await transcribePcm(serverConfig.iflytekAsr, pcm);
    return NextResponse.json({ text });
  } catch (e: any) {
    console.error("[Iflytek ASR]", e);
    return NextResponse.json(
      { error: true, msg: e?.message ?? "ASR failed" },
      { status: 500 },
    );
  }
}

export const POST = handle;
export const OPTIONS = handle;
