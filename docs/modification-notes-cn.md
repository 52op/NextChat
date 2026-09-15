# 修改记要 — 服务端预置聊天同步

本文档记录本次 fork 相对上游 `ChatGPTNextWeb/ChatGPT-Next-Web`（commit `defdcdb5`）的全部改动，用于：

- 同步上游更新后，快速定位哪些文件需要重新打补丁；
- 理解每处改动的目的与实现方式，便于排查问题或二次开发。

## 功能概述

新增「服务端托管同步」：
- 同步凭据通过环境变量配置在服务端（Vercel），**不**下发到浏览器。
- 客户端同步请求只带访问 Code，由 `/api/webdav`、`/api/upstash` 代理路由做鉴权并注入服务端凭据。
- 换新设备只需输入访问 Code，页面加载后自动执行一次云同步。

## 改动文件清单（共 13 个）

| 文件 | 改动性质 | 冲突风险 |
|---|---|---|
| `.env.template` | 新增文档 | 低 |
| `app/config/server.ts` | 新增环境变量解析 | 中 |
| `app/api/config/route.ts` | 新增 `serverSyncProvider` 下发 | 低 |
| `app/api/webdav/[...path]/route.ts` | 鉴权 + 凭据注入 + 默认 endpoint | 中 |
| `app/api/upstash/[action]/[...key]/route.ts` | 鉴权 + 凭据注入 + 默认 endpoint | 中 |
| `app/store/access.ts` | 新增 `serverSyncProvider` 默认值、`configLoaded()` | 低 |
| `app/store/sync.ts` | 核心：托管模式、自动同步 | 高 |
| `app/utils/sync.ts` | 新增 `isAppStateHydrated()` | 低 |
| `app/utils/cloud/index.ts` | `SyncClientOptions`、签名变更 | 中 |
| `app/utils/cloud/webdav.ts` | 托管模式分支 | 中 |
| `app/utils/cloud/upstash.ts` | 托管模式分支 | 中 |
| `app/components/settings.tsx` | 托管模式 UI | 中 |
| `app/components/home.tsx` | 注册自动同步 | 低 |

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
7. 全部满足 → 置 `autoSyncStarted = true`，执行 `sync()`（内部捕获异常，不阻塞页面）。

**重打补丁注意**：此文件与上游 sync.ts 差异最大。上游若调整 sync/import/export 方法，需保留：
- `effectiveProvider()` / `serverSyncProvider()` 及所有调用点；
- `getClient()` 的 options 参数；
- `autoSync()` 及模块级注册逻辑。

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

# 单测（157 个用例）
node --no-warnings --experimental-vm-modules node_modules/jest/bin/jest.js --ci

# 注意：yarn lint 在本仓库（含干净 main）原本就报
# "Cannot read properties of undefined (reading 'loc')"，与本次改动无关。
```

## 回退方法

若要完整撤销此功能：`git revert` 本分支涉及改动，或直接删除 `docs/deploy-server-sync-cn.md` 外列出的 13 个文件上的 diff 即可恢复上游行为（同步凭据回落到客户端手动配置）。
