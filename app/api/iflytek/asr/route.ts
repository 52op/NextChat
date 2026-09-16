import { NextRequest, NextResponse } from "next/server";
import { getServerSideConfig } from "@/app/config/server";
import { auth } from "@/app/api/auth";
import { ModelProvider } from "@/app/constant";
import { transcribePcm } from "@/app/utils/iflytek-asr";
import {
  isPcmSilent,
  normalizeGain,
  pcmDiagnostics,
  voiceActivity,
} from "@/app/utils/pcm-resample";

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
    const diag = pcmDiagnostics(pcm);
    console.log(
      "[Iflytek ASR] in=" +
        diag.frameCount +
        "f/" +
        diag.durationSec.toFixed(1) +
        "s peak=" +
        diag.peak +
        " rms=" +
        diag.rms +
        " silent=" +
        isPcmSilent(pcm),
    );

    // normalizing the level is a safe single-variable behavior change: it can
    // only help (never attenuates), and it lets the whole test cycle tell us
    // whether a whisper-quiet recording was the problem
    const normalized = normalizeGain(pcm);
    const text = await transcribePcm(serverConfig.iflytekAsr, normalized);
    console.log("[Iflytek ASR] out=" + JSON.stringify(text));
    const diagOut = pcmDiagnostics(normalized);
    const act = voiceActivity(pcm);
    return NextResponse.json({
      text,
      debug: `进包${diag.frameCount}采样/${diag.durationSec.toFixed(1)}s 峰值${
        diag.peak
      } rms${Math.round(diag.rms)} 后峰值${diagOut.peak} 活动帧${
        act.activeFrames
      }(${act.percent}%) 语音${act.firstSec.toFixed(1)}-${act.lastSec.toFixed(
        1,
      )}s`,
    });
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
