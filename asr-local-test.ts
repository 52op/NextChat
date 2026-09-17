import { transcribePcm } from "./app/utils/iflytek-asr";
import { readFileSync } from "fs";

// Local iflytek replay tool (bypasses Vercel).
// Usage:
//   npx tsx asr-local-test.ts                      # use ./synth16k.pcm (s16le 16k)
//   npx tsx asr-local-test.ts path/to/audio.wav    # wav or raw s16le 16k pcm
//   npx tsx asr-local-test.ts --b64 <base64>       # base64 wav as logged by the app
//
// The app logs "[VoiceInput] empty wav base64 (...): <base64>" on an empty result;
// paste that string here to replay the exact bytes the server heard.

const config = {
  appId: "1e20bf92",
  apiKey: "36169c0e02b63242fc589053bbd9e2a7",
  apiSecret: "MTkyZGIzZWVmNGVhNzA3NjI1MWI2OTZi",
};

function stripWav(buf: Buffer): Buffer {
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF") {
    let off = 12;
    while (off < buf.length) {
      const id = buf.toString("ascii", off, off + 4);
      const sz = buf.readUInt32LE(off + 4);
      if (id === "data") return buf.subarray(off + 8, off + 8 + sz);
      off += 8 + sz;
    }
  }
  return buf;
}

async function main() {
  const argv = process.argv.slice(2);
  let pcm: Uint8Array;
  if (argv[0] === "--b64") {
    pcm = stripWav(Buffer.from(argv[1], "base64"));
    console.log("[test] from base64, pcm bytes:", pcm.length);
  } else if (argv[0]) {
    pcm = stripWav(readFileSync(argv[0]));
    console.log("[test] from", argv[0], "pcm bytes:", pcm.length);
  } else {
    pcm = new Uint8Array(readFileSync("./synth16k.pcm"));
    console.log("[test] synth pcm bytes:", pcm.length);
  }
  try {
    const { text, wsStat } = await transcribePcm(config, pcm, 15000);
    console.log("[test] text:", JSON.stringify(text));
    console.log("[test] wsStat:", JSON.stringify(wsStat));
  } catch (e: any) {
    console.error("[test] ERROR:", e.message);
  }
  process.exit(0);
}
main();
