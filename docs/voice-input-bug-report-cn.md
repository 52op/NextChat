# NextChat 移动端语音输入问题报告（转交其他 AI 排查）

## 一、项目背景

- 项目：`ChatGPTNextWeb/ChatGPT-Next-Web`（NextChat）私有 fork
- 部署：Vercel（Hobby 免费计划），域名 `https://chat.it0731.cn`，访问有 `CODE` 门禁（前端输入 code 后可用）
- 技术栈：Next.js 14 App Router、React 18、TypeScript
- 前端路由是 **HashRouter**（URL 形如 `https://chat.it0731.cn/#/chat`、`/#/settings`），**这点很关键，见下面调研结论**

本问题 = 在 fork 上新增的「语音输入」功能：输入框左侧喇叭/麦克风切换按钮 → 点按后整个输入框变成「按住说话」大按键 → 松开转写为文字填入输入框。引擎优先用 **讯飞「实时语音转写大模型」**（服务端持密钥代理），回退浏览器 Web Speech API。

## 二、目标行为

1. 文字模式：输入框左侧有麦克风切换按钮（发送键保留）
2. 语音模式：整个输入区变「按住 说话」表面，按住说话、松开转写
3. 转写结果填入输入框并自动切回文字模式
4. PC + Android Chrome + iOS Safari 都要能用

## 三、问题的具体表现（真机实测，最近一次测试结果）

### Android 手机
- 点麦克风按钮进入语音模式
- **按住「按住 说话」区域**：先出现短暂"..."（正在转写图标）状态，**马上又变回麦克风图标**
- **手机顶部状态栏一直显示麦克风使用中标志**（即 stream 拿到了且一直未释放）
- 松手后没有任何结果、没有提示

### iPhone（iOS Safari）
- 点麦克风按钮进入语音模式
- **按一下语音按钮后，界面就一直停在"..."状态**（转写中），无法结束
- **顶部没有麦克风被调用的提示**（说明 getUserMedia 可能一直 pending 或失败）

### 早期版本（供参考的演变）
- v1（AudioWorklet + `AudioContext({sampleRate:16000})`）：移动端报「录音太短，请再说一次」（worklet 无数据）
- v2（ScriptProcessorNode）：iOS 点一下变"..."卡死、无提示
- v3（微信式交互）：开始报「没有识别到内容，请重试」（有录音长度但识别为空）
- v4（resume 提前到手势内 + 静音检测）：同上
- **v5（当前，单例 context + 预授权）**：安卓如上「短暂...→回弹图标＋顶部麦克风常驻」；iOS「一直..."」无麦克风提示

## 四、已确认**正常**的部分（排除项，别再重复排查）

1. **讯飞服务端链路完全正常**：
   - 用系统 TTS 生成中文语音「你好，请问今天天气怎么样」
   - ffmpeg 重采样到 44100Hz 和 48000Hz 各一份
   - 走代码里同一个 `resampleTo16kPcm` 重采样到 16k
   - 走代码里同一个 `transcribePcm`（`app/utils/iflytek-asr.ts`）连讯飞 WebSocket
   - **两种采样率都成功识别出文字**：`"你好，请问今天天气怎么样？"`
   - 讯飞密钥有效、签名算法正确、ws 推流正确、结果聚合正确
2. **PC 桌面端**：语音输入可正常工作吗？——**尚未做过真人桌面端录音测试**，无结论
3. **重采样逻辑** `app/utils/pcm-resample.ts`：16k 输出、幅值 clamp、静音检测 `isPcmSilent` 均有单测通过
4. 服务端 `/api/iflytek/asr`（Node runtime, maxDuration 60s）：鉴权、PCM 接收、转写均正常

## 五、关键代码现状（当前最新实现）

### 5.1 录音（`app/components/voice-input.tsx`）

当前实现的核心思路（v5，commit `339645e0`）：

```ts
// 模块级单例，整个会话只建一次
let sharedContext: AudioContext | null = null;
let sharedStream: MediaStream | null = null;

async function prepareVoiceRecorder() {
  // 进入语音模式时（点切换按钮的手势内）调用：
  // 1. 获取/创建单例 AudioContext
  // 2. context.resume()（要求在手势内）
  // 3. await navigator.mediaDevices.getUserMedia({audio}) 并保存 sharedStream
}

class PcmRecorder {
  async start() {
    // 每次按住说话时调用：
    // 1. 复用 sharedContext，先 context.resume()（在 touchstart 手势内）
    // 2. 复用 sharedStream（若已授权，不再弹权限框）
    // 3. ctx.createMediaStreamSource(sharedStream)
    // 4. ctx.createScriptProcessor(4096,1,1) → onaudioprocess 收集 Float32Array
    // 5. source.connect(processor); processor→gain(0)→destination
  }
  stop() { teardown(); return resampleTo16kPcm(全部chunk, context.sampleRate); }
}
```

UI 事件（防止 iOS 文本选择/长按 callout）：
```tsx
<div
  onTouchStart={(e)=>{e.preventDefault(); startHold();}}
  onTouchEnd={(e)=>{e.preventDefault(); endHold();}}
  onTouchCancel={(e)=>{e.preventDefault(); cancelHold();}}
  onMouseDown={...} onMouseUp={...} onMouseLeave={...}
>
```
- 转写流程：`stopIflytek()` → `pcm` 长度过短则「录音太短」；`isPcmSilent(pcm)` 则「没有检测到声音」；否则 `fetch("/api/iflytek/asr")` 上传 → 返回 `{text}` → `onResult(text)`
- static 状态机：`starting`（"..."状态）→ `recording`（"松开 结束"）→ `processing`（"转写中"）

完整文件：`app/components/voice-input.tsx`（约 620 行）

### 5.2 服务端代理（`app/api/iflytek/asr/route.ts`）
- `runtime = "nodejs"`, `maxDuration = 60`
- `auth()` 通过 CODE 鉴权
- 接收 raw PCM 或 WAV（剥离 RIFF 头），>40s 拒绝
- 调 `transcribePcm`（`app/utils/iflytek-asr.ts`）：HMAC 签名 → 连 `wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1` → 每 40ms 推 1280B → 发 `{"end":true,"sessionId":...}` → 聚合 `type=0` 最终结果

### 5.3 浏览器端入口（`app/components/chat.tsx`）
- `voiceMode` state；`voiceEngine` hook（读 `/api/config` 下发的 `enableIflytekAsr`）
- 文字模式：`[麦克风切换按钮] [textarea] [发送键]`
- 语音模式：`VoiceInputBar` 占满整个输入区（键盘按钮 + 按住说话表面）

## 六、已做的线上调研结论（给下一位排查者作参考，别重复踩坑）

### 6.1 iOS standalone PWA + hash 路由吊销麦克风权限（重大嫌疑）
- **WebKit bug #215884**：iOS 将网站添加到主屏幕（standalone PWA 模式）后，**每次 URL hash 变化都会吊销摄像头/麦克风权限**
- NextChat 恰好用 **HashRouter**，切页就是改 hash（`#/chat`→`#/settings`）→ 权限反复失效
- 已做部分应对：进入语音模式时在**一次手势内** getUserMedia 预授权并持有 stream；standalone 模式失败时给专项提示
- 但用户是用 **Safari 直接打开** 还是 **PWA 添加到主屏幕打开**？——**未与用户确认过**（需确认！）

### 6.2 iOS Safari AudioContext 限制
- 每页最多约 4 个 `AudioContext` 实例（网上多篇引用），且 **new 出来的新实例不继承已解锁状态**
- 解锁后过几秒可能重新锁定（iOS 18.x 有人报告约 5 秒）
- `resume()` 必须在用户手势调用栈内调用，`await getUserMedia` 之后再 `await resume()` 往往失效
- 已做应对：单例 context、`start()` 里把 resume 放最前（手势内）、`createMediaStreamSource` 前再 resume 一次

### 6.3 Android 侧症状疑似
- 顶部麦克风常驻 = `sharedStream` 的 track 一直 active（进入语音模式就持有，退出才 stop）——**这可能是设计使然，但也可能是视图卡在 starting 导致的误判**
- 安卓上「短暂"..."马上回弹图标」：疑似 `start()` 里某个 await（如 `context.resume()`）永远不 resolve/不 reject，或者 `preventDefault` 失效导致 touchend 提前触发，或 `ScriptProcessorNode` 在 `onaudioprocess` 根本不回调（无数据 → `isPcmSilent` 拦截 → 但用户没看到 toast？）

## 七、给下一位排查者的问题清单/疑点

1. **[最高优先] 确认用户访问方式**：手机是用 Safari 直接打开 `https://chat.it0731.cn`，还是「添加到主屏幕」的 PWA 图标打开？这直接决定 WebKit #215884 是否就是全部原因。
2. **iOS 一直"..."状态**：说明 `start()` 卡住（`starting=true` 未能推进到 `recording`）。`start()` 里哪一行不返回？最可能是 `context.resume()`（卡在 pending）或 `getUserMedia`（卡在等待）。建议在 `start()` 里加显式超时/状态日志，或改用手势内同步 init 完毕后置 `armedRef`。
3. **ScriptProcessorNode vs AudioWorklet 抉择**：现在用 ScriptProcessorNode（已废弃但跨浏览器可用）。iOS Safari 上 `onaudioprocess` 是否稳定回调？可以在页面里跑一个 2 秒诊断，把 `chunks.length` 和 `context.state` 打到 console/页面上确认。
4. **是否有别的前置**：讯飞密钥写在 Vercel 环境变量 `IFLYTEK_ASR_APP_ID/API_KEY/API_SECRET`，是否确保新部署后 `/api/config` 返回 `enableIflytekAsr:true`？（前端按钮出现依赖此值）
5. **Android 顶部麦克风常驻 + 回弹图标**：是否因为「进入语音模式即 getUserMedia 持流」与「视图回 idle」同时出现，给用户造成"卡住"错觉？还是 `start()` 实际抛错被吞？建议在 `catch` 里 console 全量错误 + toast。
6. 是否值得换用更简单的录音方案（如 `MediaRecorder` 录 webm → 服务端转笔 / 或接 `@xenova/transformers` / 或改走 Web Speech），还是坚持讯飞 PCM 链路。
7. **是否考虑弃用 HashRouter 的影响**：若 PWA 权限吊销实锤，可考虑：引导用户只用 Safari 打开；或在文档里明示不支持 PWA 模式语音。

## 八、可复现步骤（给另一个人跑）

1. `yarn install && yarn dev`，本地配好环境变量（讯飞三件套 + `CODE`）
2. 或直接看已部署的 `https://chat.it0731.cn`（输入访问 code 后进聊天页）
3. Chrome 桌面 DevTools → 设备模拟 iPhone / Android；或真机
4. 点输入框左侧麦克风 → 进入语音模式 → 按住「按住 说话」→ 观察：
   - 是否出现"..."且卡住（iOS 疑似）
   - 是否"..."后回弹图标 + 顶部麦克风常驻（Android 疑似）
   - console 里 `[VoiceInput]` 相关日志（现在已有的 warn/error 要打全）

## 九、关键文件清单

| 文件 | 作用 |
|---|---|
| `app/components/voice-input.tsx` | 语音输入全部前端逻辑（录音/状态机/UI 事件/上报） |
| `app/components/voice-input.module.scss` | 样式 |
| `app/components/chat.tsx` | 挂载点、voiceMode 切换 |
| `app/api/iflytek/asr/route.ts` | 讯飞 ASR 服务端代理（Node runtime） |
| `app/utils/iflytek-asr.ts` | 讯飞签名 + WebSocket 转写（已实测可用） |
| `app/utils/pcm-resample.ts` | 16k 重采样 + 静音检测 |
| `app/config/server.ts` | 环境变量解析 `IFLYTEK_ASR_*` |
| `test/iflytek-asr.test.ts` `test/pcm-resample.test.ts` | 单测 |

## 十、现状结论

- 服务端转写链路、重采样、签名：**可以用，已实测**
- 前端录音在移动端的**可靠启动**是唯一没解决的卡点，症状集中在「hold 时 AudioContext/stream 未就绪 or 状态机卡在 starting」
- 用户侧是否需要 PWA 支持语音，请优先确认