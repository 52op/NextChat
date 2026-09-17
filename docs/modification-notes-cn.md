# 修改记要 — 服务端预置聊天同步 + 语音输入

本文档记录本次 fork 相对上游 `ChatGPTNextWeb/ChatGPT-Next-Web`（commit `defdcdb5`）的全部改动，用于：

- 同步上游更新后，快速定位哪些文件需要重新打补丁；
- 理解每处改动的目的与实现方式，便于排查问题或二次开发。

## 功能概述

新增「服务端托管同步」：
- 同步凭据通过环境变量配置在服务端（Vercel），**不**下发到浏览器。
- 客户端同步请求只带访问 Code，由 `/api/webdav`、`/api/upstash` 代理路由做鉴权并注入服务端凭据。
- 换新设备只需输入访问 Code，页面加载后自动执行一次云同步，
  此后每 60 秒自动后台同步一次（切回页面时立即同步），多设备实时互通。

新增「语音输入」：
- 聊天输入框麦克风按钮，按住说话、松开转写填入输入框。
- 引擎优先级：讯飞实时语音转写大模型（服务端持密钥）→ 浏览器 Web Speech API 兜底。
- 讯飞凭据只存服务端，转写请求经 `/api/iflytek/asr`（Node runtime，带 auth 鉴权）。

## 改动文件清单（共 16 个）

| 文件 | 改动性质 | 冲突风险 |
|---|---|---|
| `.env.template` | 新增文档 | 低 |
| `app/config/server.ts` | 新增环境变量解析（同步 + ASR） | 中 |
| `app/api/config/route.ts` | 下发 `serverSyncProvider` / `enableIflytekAsr` | 低 |
| `app/api/webdav/[...path]/route.ts` | 鉴权 + 凭据注入 + 默认 endpoint | 中 |
| `app/api/upstash/[action]/[...key]/route.ts` | 鉴权 + 凭据注入 + 默认 endpoint | 中 |
| `app/api/iflytek/asr/route.ts` | 新增：讯飞 ASR 转写端点（Node runtime） | 中 |
| `app/store/access.ts` | 新增 `serverSyncProvider` / `enableIflytekAsr` 默认值、`configLoaded()` | 低 |
| `app/store/sync.ts` | 核心：托管模式、自动同步 | 高 |
| `app/utils/sync.ts` | 新增 `isAppStateHydrated()` | 低 |
| `app/utils/iflytek-asr.ts` | 新增：讯飞签名 + WS 转写逻辑 | 中 |
| `app/utils/cloud/index.ts` | `SyncClientOptions`、签名变更 | 中 |
| `app/utils/cloud/webdav.ts` | 托管模式分支 | 中 |
| `app/utils/cloud/upstash.ts` | 托管模式分支 | 中 |
| `app/components/settings.tsx` | 托管模式 UI | 中 |
| `app/components/home.tsx` | 注册自动同步 | 低 |
| `app/components/voice-input.tsx` (+module.scss) | 新增：麦克风语音输入组件 | 中 |
| `app/components/chat.tsx` | 挂载 VoiceInput | 中 |
| `app/lib/audio.ts` | 可配置采样率 + PCM 重采样导出 | 中 |
| `app/locales/cn.ts` / `en.ts` | 语音输入文案 | 低 |
| `package.json` | 新增依赖 `ws`、`@types/ws` | 低 |
| `test/iflytek-asr.test.ts` | 新增签名/URL 单测 | 低 |

## 逐文件改动细节

### 1. `.env.template`
新增说明注释与变量：
```
SYNC_PROVIDER=            # "webdav" | "upstash"，留空关闭
WEBDAV_ENDPOINT=
WEBDAV_USERNAME=
WEBDAV_PASSWORD=
UPSTASH_ENDPOINT=
UPSTASH_USERNAME=
UPSTASH_API_KEY=
```

### 2. `app/config/server.ts`
- `declare global ProcessEnv` 新增 7 个环境变量类型声明。
- `getServerSideConfig()` 内新增 `serverSync` 对象（provider + webdav + upstash 三组凭据）。
- `SYNC_PROVIDER` 只接受 `webdav`/`upstash`，否则 provider 为空。
- `WEBDAV_ENDPOINT` 非空时自动 `push` 进 `allowedWebDavEndpoints`（SSRF 白名单），省去手填 `WHITE_WEBDAV_ENDPOINTS`。
- 返回值增加 `serverSync` 字段。

**重打补丁注意**：若上游在此函数尾部新增配置项，把 `serverSync,` 追加到 return 对象即可；`allowedWebDavEndpoints` 的构建位置可能变化，自动白名单逻辑跟随。

### 3. `app/api/config/route.ts`
`DANGER_CONFIG` 新增：
```ts
serverSyncProvider: serverConfig.serverSync.provider,
```
只下发 provider 名，**不含任何凭据**（该路由会返回给所有客户端）。

### 4. `app/api/webdav/[...path]/route.ts`
- 新增 `import { auth } from "@/app/api/auth"` 与 `ModelProvider`。
- handler 开头（OPTIONS 之后）调用 `auth(req, ModelProvider.GPT)`，失败返回 401。**注意：`runtime = "edge"`，auth 使用 spark-md5 需确认在 edge 下可用（上游 openai 等边缘路由已在用，安全）。**
- `endpoint` 缺省时回退到 `config.serverSync.webdav.endpoint`（仅服务端托管时）。
- 出站 `authorization`：服务端托管时强制用环境变量凭据生成 `Basic`，忽略客户端带来的头（客户端头只用于 auth()，不外泄到 WebDAV 服务器）。

**重打补丁注意**：上游若改动 handler 的 endpoint 校验 / fetchOptions 逻辑，需把「endpoint 回退」与「authorization 注入」两段重新合并。

### 5. `app/api/upstash/[action]/[...key]/route.ts`
与 webdav 同理：
- 入口 `auth()` 鉴权。
- `endpoint` 缺省回退 `config.serverSync.upstash.endpoint`。
- 出站 `authorization` 服务端托管时注入 `Bearer ${config.serverSync.upstash.apiKey}`。

### 6. `app/store/access.ts`
- `DEFAULT_ACCESS_STATE` 新增 `serverSyncProvider: ""`（会被 `/api/config` 的下发值覆盖）。
- 新增方法 `configLoaded()`：返回 `fetchState >= 2`，供自动同步判断服务端配置是否已拉取。

**重打补丁注意**：`DEFAULT_ACCESS_STATE` 上游经常新增字段（新模型供应商等），合并时注意把 `serverSyncProvider` 保留。

### 7. `app/store/sync.ts`（核心）
- 模块级：`autoSyncStarted`（每会话只跑一次）、`autoSyncTimer`。
- `registerAutoSync()`：注册 accessStore 订阅 + 1s 轮询（30s 超时兜底）。触发条件满足即执行自动同步，轮询停止；订阅保留（用户稍后输入 Code 仍可触发）。
- 定时后台同步：`startPeriodicSync()` 在初始 `autoSync()` 成功后开启，每 60 秒 `sync()` 一次（`PERIODIC_SYNC_INTERVAL` 可调），并监听 `visibilitychange`（切回页面时立即同步）。带 `isPeriodicSyncing` 防重入。仅托管模式且已授权时生效。`stopPeriodicSync()` 可随时停止。
- 新增方法：
  - `serverSyncProvider()`：读 accessStore。
  - `effectiveProvider()`：托管时返回服务端 provider，否则本地 provider。
  - `cloudSync()`：托管时恒 true。
  - `getClient()`：透传 `SyncClientOptions`（serverManaged、accessCode、proxy 设置）。
  - `sync()`：改用 `effectiveProvider()`。
  - `autoSync()`：见下。
- `markSyncTime()` 用 `effectiveProvider()` 记录。

`autoSync()` 判定顺序：
1. 已跑过 → true。
2. 桌面 app（`buildMode === "export"`）→ true（无服务端）。
3. `configLoaded()` 为 false → false（等 `/api/config`，否则无法判断是否托管）。
4. 非托管 → true（保持手动模式）。
5. `needCode && !accessCode` → false（等用户输 Code）。
6. 所有相关 store 未 hydration → false（避免把空本地状态传上云端）。
7. 全部满足 → 置 `autoSyncStarted = true`，执行 `sync()`（内部捕获异常，不阻塞页面），随后 `startPeriodicSync()` 开启定时后台同步。

**重打补丁注意**：此文件与上游 sync.ts 差异最大。上游若调整 sync/import/export 方法，需保留：
- `effectiveProvider()` / `serverSyncProvider()` 及所有调用点；
- `getClient()` 的 options 参数；
- `autoSync()`、`registerAutoSync()`、`startPeriodicSync()`/`stopPeriodicSync()` 及模块级注册逻辑。

### 8. `app/utils/sync.ts`
新增导出 `isAppStateHydrated()`：检查 Chat/Access/Config/Mask/Prompt 五个 store 的 `_hasHydrated`。导入已存在的 `useChatStore/useAppConfig/useMaskStore/usePromptStore`（文件头部已 import，无新增循环依赖）。

### 9. `app/utils/cloud/index.ts`
- 新增 `SyncClientOptions` 类型：`{ useProxy, proxyUrl, serverManaged, accessCode }`。
- `createSyncClient` 增加第三参 `options`；`SyncClientConfig` 的 infer 加 `...args: any[]`；调用改为显式 cast 的 `createClient(config, options)`（解决 T 为联合类型时 config 推断为 never 的问题）。

### 10. `app/utils/cloud/webdav.ts`
- `createWebDavClient(store, options)` 签名变更。
- `proxyUrl` 读取改从 `options` 取。
- `headers()`：`serverManaged` 时返回 `Authorization: Bearer nk-<accessCode>`（供代理鉴权）；否则原 Basic。
- `path()`：`serverManaged` 时**不加** `endpoint` 查询参数（由服务端回退）。
- `path()` fallback 分支修复（commit `e41e4f4b`）：catch 分支统一用 query 数组拼接，托管模式下 proxy_method 前补 `?`，避免生成 `/api/webdav/<path>&proxy_method=MKCOL` 的错误 URL（会导致 check 得到 403）。

### 11. `app/utils/cloud/upstash.ts`
同 webdav：
- 签名加 `options`。
- `headers()` 托管模式返回 `Authorization: Bearer nk-<accessCode>`。
- `path()` 托管模式不加 `endpoint`。

### 12. `app/components/settings.tsx`
`SyncConfigModal`：
- 读取 `accessStore.serverSyncProvider`，`serverManaged` 为真时：
  - 只显示 provider 名称（`WEBDAV` / `UPSTASH` 大写），隐藏全部凭据/代理输入框；
  - 仍保留「检查」「确认」按钮。
- 非托管时 UI 与上游一致（原逻辑整体包进 `!serverManaged` 分支）。

**重打补丁注意**：上游常改设置页布局/新增 ListItem，合并时注意保持条件分支结构。

### 13. `app/components/home.tsx`
- import `registerAutoSync`。
- `Home` 的 useEffect（在 `useAccessStore.getState().fetch()` 之后）调用 `registerAutoSync()`。

### 14. `app/utils/iflytek-asr.ts`（新增）
- 讯飞实时语音转写大模型封装：签名生成（参数升序 + URL 编码 + HmacSHA1 Base64）、WS URL 构造、`transcribePcm()` 推流转写。
- `transcribePcm`：分块（1280B/40ms）推 PCM → 发 `{"end":true,"sessionId"}` → 只聚合 `type=0`（最终）结果，按 seg_id 排序拼接。
- 错误码映射（35001/35002/35006/37007 等）转中文。
- 纯 Node 模块（crypto + ws），无 `@/app` 路径依赖，可在单测中直接调用。

### 15. `app/api/iflytek/asr/route.ts`（新增）
- `runtime = "nodejs"`、`maxDuration = 60`（Vercel Hobby 上限）。
- 入口 `auth(req, ModelProvider.GPT)` 鉴权；`isIflytekAsrEnabled` 为假返回 400。
- 接收 raw PCM 或 WAV（自动剥离 RIFF 头），>40s 拒绝。
- 转写逻辑委托 `transcribePcm`，返回 `{text}`。
- 注意：`app/api/iflytek.ts` 是 Spark 聊天代理（edge，被 `[provider]/[...path]` 动态路由引用）；本 ASR 路由是独立静态路由 `/api/iflytek/asr`，优先级高于动态路由，互不冲突。项目已有目录 route 先例（`app/api/tencent/route.ts`）。

### 16. `app/lib/audio.ts`
- `AudioHandler` 构造函数加 `sampleRate` 参数（默认 24000，RealtimeChat 不变）。
- WAV 头改用 `context.sampleRate`（实际采样率）。
- 新增 `getRecordedPcm(targetRate=16000)`：合并 recordBuffer → 线性重采样 → 返回裸 s16le PCM。

### 17. `app/components/voice-input.tsx`（新增）
- 交互：文字模式在输入框左侧有麦克风切换按钮（保留发送键）；语音模式整个输入框变「按住说话」大按键，左侧键盘按钮切回。
- 引擎：`enableIflytekAsr` → iflytek；否则 `SpeechRecognition || webkitSpeechRecognition` → web-speech；`useVoiceEngine()` 响应 `/api/config`。
- 讯飞录音：**共享单例 AudioContext + 预授权 MediaStream**（`prepareVoiceRecorder`/`releaseVoiceRecorder`），点切换按钮进入语音模式时先手势内 `resume()` + `getUserMedia()` 完成授权，长按复用手势内 resume（不再每次 new context / 弹权限框）。
- 移动端关键修复（网上核实）：
  - iOS Safari 每页最多 ~4 个 AudioContext 且解锁状态不继承 → 复用单个 context。
  - iOS 18.x AudioContext 解锁数秒后重新锁定 → 每次 touchstart 手势内 resume()。
  - **iOS standalone PWA 每次 hash 变化吊销麦克风权限**（WebKit bug #215884，NextChat 用 HashRouter 踩中）→ 进入语音模式时预授权并持有 stream，退出才释放；失败时按 standalone 给出专项提示。
  - ScriptProcessorNode（非 AudioWorklet）保证 iOS Safari 也能取到 PCM，录制后用浏览器原生采样率，事后 `resampleTo16kPcm` 到 16k。
  - touch + mouse 事件（微信式）：`preventDefault` 阻止 iOS 文本选择/长按 callout；700ms 时间戳抑制 touch 后的合成 mouse 事件。
  - `isPcmSilent` 峰值检测：静音直接提示「未检测到声音」，区分录音链路坏 vs 讯飞识别空。
- Web Speech 兜底模式沿用。

### 18. `app/components/chat.tsx`
- `voiceMode` 状态 + `useVoiceEngine()`；文字模式渲染 `VoiceInputBar`（切换按钮）+ 发送键（保留）；语音模式渲染占满的 hold-to-talk 表面。`htmlFor` 在语音模式下置 undefined。

### 19. `app/locales/cn.ts` / `en.ts`
- 顶层新增 `VoiceInput` 文案块（其他语言文件为 DeepPartial，可缺省）。

### 20. `package.json`
- 新增依赖：`ws@8.18.0`（服务端 WS 客户端）、`@types/ws`（dev）。

### 21. `test/iflytek-asr.test.ts`（新增）
- 签名确定性、参数完整性、WS URL 构造、UTC 时区格式。

## 2026-09-16 语音输入可靠性修复（第二轮）

线上排查发现「加了语音输入但用不了」的两类原因，已修复：

1. **引擎被判定成 Web Speech 兜底**：部署的 `/api/config` 未下发 `enableIflytekAsr`（旧部署/未配 `IFLYTEK_ASR_*`）时，`detectVoiceEngine()` 只能回退浏览器原生识别，国内 Chrome/Edge 走 Google 服务必然失败。排查方式：Console 看 `[Config] got config from server` 是否含 `enableIflytekAsr: true`。
2. **切模式瞬间释放预授权麦克风流**（`app/components/chat.tsx`）：原来文字/语音两种模式渲染的是**两个不同的 `VoiceInputBar` 实例**，切到语音模式时旧实例卸载 → 卸载 cleanup 调 `releaseVoiceRecorder()` → 刚 `prepareVoiceRecorder()` 拿到的 stream 立刻被停掉，预授权形同虚设，每次长按都要重新 `getUserMedia`（iOS / standalone PWA 直接失败）。
   - 修法：只挂载**一个** `VoiceInputBar`，由 `voiceMode` 决定内部渲染切换按钮还是按住说话条；textarea/发送键在 `!voiceMode` 时渲染。`chat.tsx` 不再需要 `useVoiceEngine()`。
3. **`app/components/voice-input.tsx`**
   - 麦克风未就绪就松手（轻点/短按）原来**静默无反馈** → 现在提示 `Locale.VoiceInput.TooShort`（此前表现为「点了没反应」）。
   - ASR 请求强制携带 `Authorization`：`getHeaders()` 会按当前聊天模型把凭据放进 `api-key` / `x-api-key` / `x-goog-api-key`，而 `/api/iflytek/asr` 只读 `Authorization`，切到 Azure/Claude/Gemini 模型时会 401 `empty access code`；现在缺省时补 `Bearer nk-<accessCode>`。
   - 文字模式的切换按钮加 `onMouseDown` preventDefault，避免点击时聚焦 textarea、移动端弹键盘（**注意不要**在 touchstart 上 preventDefault，会抑制 click）。
4. **`app/components/voice-input.module.scss`**：补 `&.starting` 样式（麦克风 arm 中要有视觉反馈，之前 `clsx(styles["starting"])` 恒为 undefined）。
5. **`app/utils/iflytek-asr.ts`**（服务端转写健壮性）
   - 结束包 `{"end":true,"sessionId"}` 的 sessionId 兜底：握手没给 `data.sessionId` 时用 `crypto.randomUUID()`（此前会发空 sessionId）。
   - 新增收尾宽限 `ASR_FLUSH_TIMEOUT_MS=4000`：发完 end 后若服务端既不回 `ls=true` 也不断连，宽限期到点用已聚合结果 resolve（此前要等 50s 硬超时且**直接 reject**，已识别到的文字全丢，用户只看到「语音转写失败」）。
   - 硬超时改为优先返回已识别文本，仅在完全没有结果时才 reject。
6. **`test/iflytek-asr-transcribe.test.ts`（新增）**：用 `jest.unstable_mockModule("ws")` 造假的讯飞服务端，覆盖 4 条路径：收尾宽限返回、缺 sessionId 兜底、硬超时返回已有文本、无结果超时报错。
   - 注意：本仓库测试以**原生 ESM** 运行（`extensionsToTreatAsEsm` + `--experimental-vm-modules`），`jest.mock` 不会被提升，写模块 mock 必须用 `jest.unstable_mockModule` + 动态 `import()`；`jest` 需从 `@jest/globals` 导入。

## 2026-09-17 语音输入空转写排查（历史交接记录）

> 以下为上一轮排查记录，部分推断未经验证；请以文末「协议复核与修复」为准。

**症状**：Android/iOS 真机按住说话 → 松开 →「转写中」→ 数秒后「未识别到内容」。

**已确认正常**（真实测试的证据）：

| 环节 | 证据 |
|---|---|
| 真机录音管线 | 诊断全绿：51-63KB `audio/webm;codecs=opus`，解码 3-4s mono 48k，peak 12-19k，rms ~2300-3100，zcr 1900-2500，40-bin 包络为真实词-隙-词语句能量模式 |
| 讯飞凭据/签名/协议 | 本地直连讯飞 WS `started:true`、`error:false`，正确签名参数与官方一致 |
| 引擎对语音频段能量 | 本地纯正弦+包络拟真音频 → 讯飞识别出「嗯嗯嗯」`resultCount:3` `final:1`，非空 |
| 与 Vercel 无关性 | 同上，本地绕过 Vercel 直连成功 |

**未决难点**（分工交接用）：

1. **Vercel 出站 WebSocket 是否真通（最高嫌疑）**。服务端日志 `resultCount:0` 连一条结果都没有，但**未确认 `started` 字段**。判据：查看 Vercel 最新一次 `[Iflytek ASR] ws {...}` 日志的 `started` 值——
   - `started:false` 只能说明客户端未识别到会话确认；可能是连接、鉴权、消息结构或服务启动问题，不能据此断言 Vercel 阻止出站 WebSocket。
   - `started:true` 但 `resultCount:0` → 继续查 flush 竞态（见 3）。
2. **真实人声从未直接喂过讯飞（方法盲区）**。已测合成音/拟真音均非真实语音。需抓真机原始 pcm 本地重放，分离「传输路径」vs「引擎识别内容」。
3. **flush 竞态**（`ASR_FLUSH_TIMEOUT_MS` 4000→8000，commit `338588d5`）：发完 end 后讯飞偶尔 8s 级慢才回最终结果，旧 4s 宽限提前 close → `resultCount:0`。已加长，**未在真机验证**。

**已部署的取证改动**（`338588d5` flush 加长；`eae7df91` 空结果 wav 取证）：
- 空转写时 `/api/iflytek/asr` 把 normalized PCM 包成 16k wav base64 塞回 `wav` 字段。
- 前端空结果时 console 整串打 `[VoiceInput] empty wav base64 (...): <base64>`，并尝试下载 `asr-empty.wav`（PWA 可能拦截下载，console 是主途径）。
- 拿到 `<base64>` 后：本地解码 → 直连讯飞重放同一批字节 → 相同空/非空比较即定位「传输」vs「内容」。

**最短定位路径**：外层换调 —— ①Vercel 日志看 `started`；②空转写时从手机 console 抓 `empty wav base64` 串回传。

## 2026-09-17 协议复核与修复

### 已证实的代码缺陷

复核依据：[讯飞官方协议文档](https://www.xfyun.cn/doc/spark/asr_llm/rtasr_llm.html)及其 Python 示例 `lc-sp-rtasr_llm_demo-1767597748832.zip`。本轮未获得实际部署的讯飞凭据或 Vercel 运行日志，因此以下是代码和协议层面确认的问题，不代表已证明线上唯一根因。

1. **功能错误被吞掉**：官方明确给出的 `msg_type=result, res_type=frc, data.normal=false` 异常原来只增加计数。随后任何 `close` 都当成功，最终向用户提示「没有识别到内容」。现按错误返回 HTTP 502，并显示服务端说明；额度和鉴权错误也保留错误码。
2. **发送时序与会话 ID**：原来 WebSocket 一打开就开始推音频，尚未等待业务 `started` 确认；缺少服务端 sessionId 时又随机编造一个。现等待业务确认再按 1280 字节/40ms 推流；结束使用服务端 ID，没有时按官方 Python 示例省略该字段。兼容文档中的顶层 `action/data/sid` 和嵌套消息结构。
3. **空结果与截断混淆**：原来提前断连返回成功、超时返回已识别的句子前半段。现仅在完整结束或正常关闭且收到确定结果后返回成功；启动、结果等待、总时长都有明确超时并释放定时器。结果等待为 10 秒无进展超时，收到结果后重新计时；总截止时间为 55 秒，路由 `maxDuration=60`。
4. **音频视图错误**：`new Int16Array(pcm.buffer)` 忽略 Node Buffer/WAV 子视图的 byteOffset 和 byteLength，导致诊断读取其他字节、增益处理被跳过。所有 PCM 工具改为只处理当前视图，并处理奇数偏移。静音检测不再每隔 100 个采样取一点，避免固定频率落在零点导致误判。
5. **WAV 输入校验**：增加 `app/utils/asr-audio.ts`，校验 16k/16bit/单声道 PCM、chunk 边界和奇数长度填充。损坏或格式不符返回 400，避免把 WAV 头当音频发送。
6. **录音生命周期**：合并并发权限请求、重新获取已结束的轨道、退出空闲语音模式也释放麦克风、忽略卸载后的权限结果、取消转写请求后禁止回填。Web Speech 模式不再额外占用 MediaRecorder 麦克风流。
7. **撤除试探性处理**：不再强制禁用浏览器降噪/回声处理，不再对每段录音自动增益，不再在空结果时返回/打印/自动下载整段音频。默认保留不含音频和转写正文的传输统计；显式设置 `localStorage.voiceDownloadDebug=1` 仍可在本机导出录音。

### 验证及部署复测

- TypeScript 类型检查通过；Jest 全量 39 个套件、214 个用例通过。
- 增加/更新讯飞协议、PCM 子视图、WAV 解析、麦克风资源生命周期回归测试。模拟测试证明这些缺陷已修复，不能代替 Vercel 与手机实测。
- 无需增加环境变量。部署修复后刷新页面，先录制一句 3–5 秒的清晰语音；正常结果应填入输入框。
- 若仍失败，记录页面错误文案及同一次请求的 `[Iflytek ASR] ws` 日志：`started`、`sentBytes`、`sentEnd`、`resultCount`、`other`、`closeCode`、`failure`。`ASR_ENGINE_ERROR` 表示讯飞返回功能异常，`ASR_CONNECTION_CLOSED` 表示链路提前结束，`ASR_*TIMEOUT` 表示对应阶段未完成。
- 只有收到有效的空 ASR 结果才显示「没有识别到内容」。不要再以该提示、单个 `started:false` 或一次本地合成音测试直接推断 Vercel 网络或真机麦克风正常/异常。

## 2026-09-17 服务器实测根因与修复（Windows standalone 部署）

在自行部署的 Windows Server 2012 R2（Node 20.20.2，standalone 模式）上实测，找到了之前无法在 Vercel 复现的**运行时根因**：

### 现象
- 服务端 ASR 每次固定推流到 **29440 字节**（约 23×1280B、≈0.92s）后，讯飞返回 `{action:"end", code:"999999"}`（Unkown Error）并断开（closeCode 1006）。
- 相同音频、相同签名、相同推流时序的**独立 Node 脚本**（直接 require 项目根 `node_modules/ws@8.18.0`）**完全成功**，识别出完整文字。→ 排除服务器网络、签名、音频、推流节奏问题。

### 根因
- Next.js `next build`（standalone）会**把 `ws` 打包进 webpack chunk**（内联为 8.13.x 的裁剪实现，standalone 目录里找不到独立 `ws` 包文件）。
- 该打包实现与大体积/持续推流不兼容：约 29440 字节后被对端拒绝（讯飞 999999）。
- 独立脚本用的是根 `node_modules/ws@8.18.0`（完整实现），故成功。

### 修复
- `next.config.mjs`：在 `webpack()` server 分支把 `ws` 加入 `config.externals`，并在 `experimental.serverComponentsExternalPackages: ["ws"]` 声明，使 `ws` **不打包**、运行时从 `node_modules` 解析。
- 重新构建后 standalone 目录出现 `node_modules/ws`（8.18.0），ASR 请求 `sentBytes:187120`（全量推送）、`sentEnd:true`，完整转写成功：
  ```
  {"text":"你好，请问今天天气怎么样？我想去公园散步。", ...}
  ```

### 若后续在 Vercel 复现
- Vercel 的 `outputFileTracing` 通常也会把 external 包带入函数，但不排除其自带 ws 版本差异。若 `[Iflytek ASR] ws` 出现固定近 30KB 后 `code:999999`，优先检查部署产物里 `ws` 的来源与版本，而不是网络。

### Windows 自托管部署要点（Node standalone）
- 用**计划任务**（`schtasks`）开机自启、脱离 SSH 会话运行：`node .next/standalone/server.js`，`PORT=8086` `HOSTNAME=0.0.0.0`。
- standalone 目录需手动补齐 `.env`、`public/`、`.next/static`（Next 不会自动复制）。
- 服务器 PowerShell 5.1 需强制 TLS 1.2（`[Net.ServicePointManager]::SecurityProtocol=Tls12`）才能访问 registry 下载依赖。

## 上游同步后的重打流程

1. `git fetch upstream && git merge upstream/main`（或 rebase）。
2. 按上表逐文件检查冲突：
   - 低/中风险文件直接解冲突。
   - 高风险的 `app/store/sync.ts` 建议以冲突标记为准，手动把「7 节」列出的保留点合并回新结构。
3. 解完冲突后运行验证：
   ```bash
   npx tsc --noEmit
   node --no-warnings --experimental-vm-modules node_modules/jest/bin/jest.js --ci
   ```
4. 冒烟测试：本地起 dev，配好环境变量（见部署文档），确认自动同步触发。

## 验证命令

```bash
# 类型检查
npx tsc --noEmit -p tsconfig.json

# 单测（161 个用例）
node --no-warnings --experimental-vm-modules node_modules/jest/bin/jest.js --ci

# 注意：yarn lint 在本仓库（含干净 main）原本就报
# "Cannot read properties of undefined (reading 'loc')"，与本次改动无关。
```

## 回退方法

若要完整撤销此功能：`git revert` 本分支涉及改动，或直接删除本文档改动清单内列出的文件上的 diff 即可恢复上游行为（同步凭据回落到客户端手动配置、语音输入按钮消失）。
