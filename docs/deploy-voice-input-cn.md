# 语音输入（讯飞实时语音转写大模型）— 部署指南

本分支（fork）新增语音输入功能：聊天输入框右侧的麦克风按钮，按住说话、松开即把语音转成文字填入输入框。

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
2. 打开聊天页，输入框右侧会出现麦克风按钮。
3. **按住**按钮说话，松开后自动转写：
   - 讯飞模式：文本填入输入框（可编辑后发送）。
   - Web Speech 模式：识别结果直接填入输入框（可能无标点）。
4. 也可以直接输入文字，两种方式并存。

## 四、限制与注意事项

- **录音时长**：Vercel Hobby 函数最长 60s，语音建议控制在 **40 秒内**。更长的语音会超时。
- **访问 Code**：`CODE` 未配置时，`/api/iflytek/asr` 也无需鉴权（沿用项目 auth 逻辑），任意访问者可能消耗你的讯飞额度，**强烈建议设置 `CODE`**。
- **免费额度**：实时语音转写大模型需在讯飞控制台领取免费额度或购买套餐；额度用尽会返回「转写用量不足」。
- **浏览器兼容**：桌面 Chrome/Edge 录音与转写体验最佳；Safari 14.1+ 走 Web Speech 兜底；Firefox 默认不支持 Web Speech 且若未配置讯飞则无麦克风按钮。
- **隐私**：音频会发给讯飞服务器（仅在你启用讯飞模式时）；Web Speech 模式音频走浏览器厂商（Chrome 为 Google）。

## 五、自托管（可选）

Vercel 免费计划有 60s 函数限制。若需超长语音，可改用 Docker 自托管（本机无此限制）：
- 镜像运行后，在同一环境变量里配好 `IFLYTEK_ASR_*` 三个值。
- 服务器公网 IP 非 80/443 端口时，用另一台云服务器做反向代理（Nginx/Caddy）到 NextChat 容器端口即可。
- 代码无需改动，仅部署环境不同。