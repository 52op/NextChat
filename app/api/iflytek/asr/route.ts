import { NextRequest, NextResponse } from "next/server";
import { getServerSideConfig } from "@/app/config/server";
import { auth } from "@/app/api/auth";
import { ModelProvider } from "@/app/constant";
import { IflytekAsrError, transcribePcm } from "@/app/utils/iflytek-asr";
import { readAsrPcm } from "@/app/utils/asr-audio";

export const runtime = "nodejs";
export const maxDuration = 60;

const serverConfig = getServerSideConfig();

export async function POST(req: NextRequest) {
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

  let pcm: Buffer;
  try {
    pcm = readAsrPcm(Buffer.from(await req.arrayBuffer()));
  } catch (error) {
    return NextResponse.json(
      {
        error: true,
        msg: error instanceof Error ? error.message : "无效的音频",
      },
      { status: 400 },
    );
  }

  try {
    // Preserve the recorded signal. Amplifying every recording (including
    // background noise) is not a substitute for a valid ASR session.
    const { text } = await transcribePcm(serverConfig.iflytekAsr, pcm);
    return NextResponse.json({ text });
  } catch (error) {
    if (error instanceof IflytekAsrError) {
      return NextResponse.json(
        {
          error: true,
          msg: error.message,
          code: error.code,
          debug: error.wsStat,
        },
        { status: error.code.includes("TIMEOUT") ? 504 : 502 },
      );
    }
    console.error("[Iflytek ASR] unexpected transcription failure");
    return NextResponse.json(
      { error: true, msg: "语音转写失败，请重试" },
      { status: 500 },
    );
  }
}

export async function OPTIONS() {
  return NextResponse.json({ body: "OK" });
}
