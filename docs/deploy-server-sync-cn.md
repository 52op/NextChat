# 服务端预置聊天同步 — 部署指南

本分支（fork）新增了「服务端托管同步」功能：把 WebDAV / Upstash 的同步凭据配置在 Vercel 环境变量里，之后任何新设备访问部署好的 NextChat 时，**只需要输入访问 Code** 即可自动拉取聊天记录，无需再手动填写同步地址、用户名、密码。

## 一、原理

- 同步凭据（endpoint / 用户名 / 密码 / token）**只存在服务端环境变量**，不下发到浏览器。
- 浏览器发起同步请求时只带上访问 Code（`Bearer nk-<code>`），打到 NextChat 自身的代理路由：
  - WebDAV: `/api/webdav/[...path]`
  - Upstash: `/api/upstash/[...action]/[...key]`
- 代理路由先做访问 Code 鉴权（复用现有 `auth()`），通过后用服务端环境变量里的凭据去请求真实的 WebDAV / Upstash。
- 客户端在页面加载后、检测到「服务端托管 + 已输入 Code + 本地数据已加载」时，**自动执行一次同步**（拉取 → 合并 → 回传）。
- 此后页面保持打开时，**每 60 秒自动后台同步一次**；切换到后台再回到页面时也会立即同步一次。多设备同时在线时，聊天记录基本保持实时互通，无需手动点同步。

## 二、环境变量配置

在 Vercel 项目 → Settings → Environment Variables 中新增：

### 通用
| 变量 | 值 | 说明 |
|---|---|---|
| `SYNC_PROVIDER` | `webdav` 或 `upstash` | 选择服务端托管的同步方式。留空 = 关闭服务端托管，回到手动配置模式 |
| `CODE` | 你的访问密码 | 访问门禁，也是同步代理的鉴权依据。强烈建议设置 |

### WebDAV 方式（`SYNC_PROVIDER=webdav`）
| 变量 | 值 |
|---|---|
| `WEBDAV_ENDPOINT` | 你的 WebDAV 完整地址，如 `https://dav.example.com/remote.php/dav/files/username` |
| `WEBDAV_USERNAME` | WebDAV 用户名 |
| `WEBDAV_PASSWORD` | WebDAV 密码（应用专用密码更安全） |

> `WEBDAV_ENDPOINT` 会自动加入 SSRF 白名单，无需再填 `WHITE_WEBDAV_ENDPOINTS`（除非你还要允许其他 endpoint）。

### Upstash 方式（`SYNC_PROVIDER=upstash`）
| 变量 | 值 |
|---|---|
| `UPSTASH_ENDPOINT` | Upstash REST 地址，如 `https://xxx.upstash.io` |
| `UPSTASH_USERNAME` | 可选，默认 `chatgpt-next-web`，作为存储 key 前缀 |
| `UPSTASH_API_KEY` | Upstash REST Token |

## 三、配置后需要做的

1. 保存环境变量后，Vercel 会自动重新部署（或手动 Redeploy 一次）。
2. 在浏览器打开部署后的地址，输入访问 Code。
3. 等待几秒，页面会自动执行首次同步，聊天记录会从云端拉取下来。
4. 在「设置 → 数据同步」中可以看到：
   - 同步提供方式显示为 `WEBDAV` / `UPSTASH`（大写），凭据输入框已隐藏，不可修改。
   - 也可以手动点「同步」按钮触发。

## 四、换设备使用

新设备打开同一部署地址 → 输入访问 Code → 自动同步完成。无需任何额外配置。同一设备上页面保持打开时也会定期自动同步，多设备之间实时互通。

## 五、安全说明

- 同步凭据绝不下发到浏览器，只由服务端代理注入，抓包/看前端代码均拿不到。
- 代理路由带鉴权：没有有效访问 Code（或未配置 Code 时开放）无法使用该代理，防止你的 WebDAV/Upstash 被当成免费中继。
- 注意：此方案为**单用户**设计。所有用户共享同一个云端存储 key（`chatgpt-next-web/backup.json` 或 `chatgpt-next-web-chunk-*`）。多用户场景会互相覆盖，不建议。
- WebDAV 凭据若使用应用专用密码（app password），泄露影响范围更小。

## 六、常见问题

**Q: 环境变量配好了但没自动同步？**
检查：`CODE` 是否已输入？是否等了几秒？浏览器控制台搜 `[AutoSync]` 看日志。若显示 `not server managed`，说明 `SYNC_PROVIDER` 没生效，检查环境变量拼写及是否重新部署。

**Q: 还能手动同步吗？**
能。设置 → 数据同步 → 同步按钮仍在。自动同步只在「服务端托管」模式下生效，手动模式行为与上游完全一致。

**Q: 要改回手动配置怎么办？**
把 `SYNC_PROVIDER` 置空并重新部署即可，同步设置界面恢复原样。
