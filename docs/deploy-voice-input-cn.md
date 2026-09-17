# 语音输入（讯飞实时语音转写大模型）— 部署指南

本分支（fork）新增语音输入功能：点击聊天输入框左侧的麦克风按钮切换模式，再按住说话，松开后把语音转成文字填入输入框。

## 一、原理

- **讯飞模式（默认优先）**：前端用浏览器录音（16kHz 单声道 PCM）→ 松开后 POST 到 NextChat 自身的 `/api/iflytek/asr` 路由 → 服务端（Vercel Node runtime，最长 60s）用环境变量里的讯飞凭据生成 HMAC 签名 → 连讯飞 WebSocket 推流转写 → 返回文本。
  - 密钥（AppID / APIKey / APISecret）**只存在服务端**，浏览器拿不到。
  - 请求先过现有 `auth()` 访问 Code 鉴权，别人无法白嫖你的讯飞额度。
  - 使用讯飞「实时语音转写大模型」：中英 + 202 种方言免切识别（`autodialect`）。
- **Web Speech API 兜底**：未配置讯飞时，自动回退到浏览器原生语音识别（Chrome / Edge / Safari）。两者都不可用时按钮隐藏。

## 二、环境变量配置

在 Vercel 项目 → Settings → Environment Variables 中新增：

| 变量 | 值 | 说明 |
|---|---|---|
| `IFLYTEK_ASR_APP_ID` | 讯飞 AppID | 控制台：console.xfyun.cn → 服务 → 实时语音转写大模型 |
| `IFLYTEK_ASR_API_KEY` | 讯飞 APIKey | 鉴权信息页面获取 |
| `IFLYTEK_ASR_API_SECRET` | 讯飞 APISecret | 鉴权信息页面获取 |

> 三个值都配置后即启用讯飞模式；缺失任一个则视为未配置，自动走 Web Speech API 兜底。
> 密钥仅在服务端使用，`/api/config` 只下发布尔值 `enableIflytekAsr`，不下发凭据。

## 三、使用

1. 配置环境变量后 Vercel 重新部署。
2. 打开聊天页，点击输入框左侧麦克风按钮，允许浏览器使用麦克风。
3. **按住「按住 说话」区域**说话，松开后自动转写：
   - 讯飞模式：文本填入输入框（可编辑后发送）。
   - Web Speech 模式：识别结果直接填入输入框（可能无标点）。
4. 也可以直接输入文字，两种方式并存。

## 四、限制与注意事项

- **录音时长**：Vercel Hobby 函数最长 60s，语音建议控制在 **40 秒内**。更长的语音会超时。
- **访问 Code**：`CODE` 未配置时，`/api/iflytek/asr` 也无需鉴权（沿用项目 auth 逻辑），任意访问者可能消耗你的讯飞额度，**强烈建议设置 `CODE`**。
- **免费额度**：实时语音转写大模型需在讯飞控制台领取免费额度或购买套餐；额度用尽会返回「转写用量不足」。
- **浏览器兼容**：配置讯飞时，浏览器需支持 MediaRecorder 和音频解码（包括现代 Chrome、Edge、Safari）；未配置时才尝试 Web Speech，其可用性还取决于浏览器厂商的识别服务和网络。
- **隐私**：音频会发给讯飞服务器（仅在你启用讯飞模式时）；Web Speech 模式音频走浏览器厂商（Chrome 为 Google）。

## 五、自托管（可选）

Vercel 免费计划有 60s 函数限制。若需超长语音，可改用 Docker 自托管（本机无此限制）：
- 镜像运行后，在同一环境变量里配好 `IFLYTEK_ASR_*` 三个值。
- 服务器公网 IP 非 80/443 端口时，用另一台云服务器做反向代理（Nginx/Caddy）到 NextChat 容器端口即可。
- 本实现仍限制每段音频 40 秒并设置 55 秒转写超时；仅更换部署平台不会自动放开这些限制。

### Windows Server 自托管（Node standalone）实测要点

已在 Windows Server 2012 R2 + Node 20.20.2 验证可用。关键点：

1. **`ws` 必须外部化**（`next.config.mjs` 已加 `experimental.serverComponentsExternalPackages: ["ws"]` + webpack externals）。否则 Next 会把 `ws` 打包进 chunk 的裁剪实现，ASR 推流约 29440 字节后被讯飞拒绝（`code:999999`），而独立脚本用根 `node_modules/ws@8.18.0` 却成功。务必使用本分支的 `next.config.mjs` 重新构建。
2. standalone 部署后手动补齐静态资源（Next 不会自动复制）：
   ```
   xcopy .next\static .next\standalone\.next\static /e /i
   xcopy public .next\standalone\public /e /i
   copy .env .next\standalone\.env
   ```
3. 用计划任务开机自启、脱离 SSH 会话运行：
   ```
   schtasks /create /tn nextchat /tr "cmd /c 启动脚本" /sc onstart /ru SYSTEM
   ```
   启动脚本内容：
   ```bat
   @echo off
   set PATH=C:\path\to\node;%PATH%
   cd /d E:\letvar\services\nextchat\.next\standalone
   set PORT=8086
   set HOSTNAME=0.0.0.0
   node server.js
   ```
4. 服务器 PowerShell 5.1 需强制 TLS 1.2 才能下载依赖：`[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12`。

## 六、多设备同步竞争的杜绝

背景：Vercel 版旧项目与自建实例曾同时向同一 WebDAV `backup.json` 自动同步（每 60 秒），Vercel edge 写 WebDAV 会截断文件，导致所有客户端 `JSON.parse` 报 `Unterminated string`。已通过移除 Vercel 项目消除写入源。

代码层面，`/api/webdav` 与 `/api/upstash` 代理路由内建**同步请求串行队列**（promise chain）：所有读写请求按到达顺序逐个执行。因此：

- 单实例部署下，任意时刻只有一次 WebDAV 读写在进行；
- 一台设备写入完成的文件，在下一台设备读取前已完整落盘，不会被读到"写一半"的截断内容；
- 实测 5 路并发 PUT 后最终文件仍为完整单 JSON。

注意：串行化基于**单进程内存队列**，仅在单实例（本部署形态）下有效；若未来横向扩展为多实例，需改分布式锁。

## 七、修复后的错误定位

服务端等待讯飞确认会话后才开始发送音频。功能异常、提前断连和超时会显示实际错误，不再全部表现为「没有识别到内容」。Vercel 日志中的 `[Iflytek ASR] ws` 包含发送字节数、结束标记、结果数及失败阶段，不包含录音或转写正文。

部署后用手机录制 3–5 秒语音验证。若仍失败，按同一请求的页面提示及上述日志定位；`started:false` 本身不足以证明 Vercel 禁止出站 WebSocket。详细修复依据和测试范围见 `docs/modification-notes-cn.md` 的「协议复核与修复」。
