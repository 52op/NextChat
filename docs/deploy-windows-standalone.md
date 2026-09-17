# Windows Server 独立部署（Standalone）指南

本文档说明如何将本项目（NextChat fork）打包为 Next.js standalone 产物，并在 Windows Server 上运行。

## 一、两种构建方式

### 方式 A：在服务器上直接构建（不推荐，慢且易失败）

需要先安装 Node.js 20（Windows Server 2012 R2 无自带包管理器，需手动下载 zip 版解压）：

1. 下载 Node 20 x64 zip 并解压，例如到 `E:\services\node\node-v20.20.2-win-x64`。
2. 上传源码到服务器，例如 `E:\services\nextchat`。
3. 配置环境变量并安装依赖：
   ```bat
   set PATH=E:\services\node\node-v20.20.2-win-x64;%PATH%
   cd /d E:\services\nextchat
   npm install --no-audit --no-fund
   ```
4. 构建：
   ```bat
   set BUILD_MODE=standalone
   npx tsx app/masks/build.ts
   npx next build
   ```
5. 产物在 `.next\standalone`。

### 方式 B：本机构建后上传（推荐）

在开发机（Windows / macOS / Linux）上构建好 standalone 产物，打包上传到服务器，服务器只需运行，不需要完整工具链。

```bash
# 开发机
yarn install
set BUILD_MODE=standalone     # PowerShell: $env:BUILD_MODE = "standalone"
yarn mask                      # 或 npx tsx app/masks/build.ts
yarn build                     # 或 npx next build
```

## 二、补齐 standalone 产物

Next.js standalone 目录**不会自动包含** `public` 和 `.next/static`，必须手动复制，否则页面样式/图标 404：

```bat
cd /d E:\services\nextchat
xcopy .next\static .next\standalone\.next\static /e /i /y
xcopy public .next\standalone\public /e /i /y
copy .env .next\standalone\.env
```

> 注意：`.env` 必须存在于 standalone 目录（或作为环境变量注入），否则 `CODE`、API key、`IFLYTEK_ASR_*` 等全部不生效。

## 三、服务端运行

### 启动脚本（`run-nextchat.bat`）

```bat
@echo off
set PATH=E:\services\node\node-v20.20.2-win-x64;%PATH%
cd /d E:\services\nextchat\.next\standalone
set PORT=8086
set HOSTNAME=0.0.0.0
echo nextchat-start %date% %time% >> E:\services\nextchat.log
node server.js >> E:\services\nextchat.log 2>&1
```

- `PORT`：对外端口（示例 8086，避免占用 80/443）。
- `HOSTNAME=0.0.0.0`：允许局域网/反代访问，默认只监听 localhost。

### 开机自启（脱离 SSH 会话）

SSH 会话断开会杀掉后台进程，必须用计划任务运行：

```bat
schtasks /create /tn nextchat /tr "cmd /c E:\services\run-nextchat.bat" /sc onstart /ru SYSTEM
schtasks /run /tn nextchat
```

验证：

```bat
netstat -ano | findstr 8086
curl http://localhost:8086/
```

### 反向代理（可选）

服务器只有非 80/443 端口时，用另一台云服务器反代。Caddy 示例：

```caddyfile
mychat.example.com {
    reverse_proxy 你的服务器IP:8086
}
```

## 四、环境变量

`.env` 文件（与 `.env.template` 对照），常见项：

```
# 访问密码（必填，强烈建议）
CODE=your-password

# OpenAI 兼容 API
OPENAI_API_KEY=sk-xxx
BASE_URL=https://api.example.com

# 讯飞语音转写（语音输入）
IFLYTEK_ASR_APP_ID=xxx
IFLYTEK_ASR_API_KEY=xxx
IFLYTEK_ASR_API_SECRET=xxx

# WebDAV 聊天同步（服务端托管模式）
SYNC_PROVIDER=webdav
WEBDAV_ENDPOINT=https://dav.example.com/path
WEBDAV_USERNAME=xxx
WEBDAV_PASSWORD=xxx

# 自定义模型
CUSTOM_MODELS=-all,+model@OpenAI=显示名
```

## 五、常见问题

### 1. 语音输入 ASR 推流到 29440 字节后被断（讯飞 999999）

根因：Next.js `next build` 会把 `ws` 打进 webpack chunk（裁剪实现），与持续推流不兼容。

修复：本项目 `next.config.mjs` 已加入：

```js
experimental: { serverComponentsExternalPackages: ["ws"] },
// webpack 里对 server 构建：config.externals = [...(config.externals ?? []), "ws"]
```

**必须用含此配置的分支重新构建**；构建后确认 standalone 目录存在 `node_modules\ws`（完整 8.18.0），且 route 运行时 require 到它。

### 2. 页面样式 / 图标 404

`public` 和 `.next/static` 未复制到 standalone，见上文「二」。

### 3. 服务随 SSH 断开而停止

必须用计划任务（`schtasks`）而非 `start` 命令。

### 4. 服务器 PowerShell 5.1 下载依赖失败

Windows Server 2012 默认 TLS 1.0，访问 registry 需强制 TLS 1.2：

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
```

### 5. 聊天同步总是报 "Unterminated string in JSON"

多客户端（如旧的 Vercel 部署）同时自动同步同一个 WebDAV 文件，写入时被截断，或浏览器缓存了损坏响应。

- 删除旧部署/停止其他同步客户端。
- 删除 WebDAV 上损坏的 `backup.json` 后重新同步。
- 本项目已给 `/api/webdav`、`/api/upstash` 加 `Cache-Control: no-store` 并串行化请求，避免读写到一半的文件。

### 6. 语音输入需要重新部署后测试

改动前端/API 后需重新构建、上传 standalone，并**强制刷新浏览器**（Ctrl+Shift+R），否则可能加载旧 chunk 报 "Loading chunk failed"。

## 六、更新流程

1. 开发机拉取最新代码 → 重新构建 standalone。
2. 停服务：`schtasks /end /tn nextchat` + 杀 node 进程。
3. 删除旧 `.next\standalone`，解压新包替换。
4. 复制 static/public/.env。
5. `schtasks /run /tn nextchat`。
6. 浏览器强刷验证。
