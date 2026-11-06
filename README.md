# dsh-human-alert

Native OS notifications for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
when an agent **actually needs you** — approvals, questions, or account re-login —
instead of waiting silently inside the browser tab.

[English](#) | [中文](#中文)

| When the agent… | Listened event | Example notification |
|---|---|---|
| waits for a tool-call approval | `approval/request` | Waiting for approval: bash — … |
| asks a question / requests plan review | `user-questions/request` (`ask_user_question`) | the question header and text |
| loses DeepSeek account sign-in | `deepseek-account/session-expired`, `model-sign-in-required` | Please sign in again |

The plugin is **observation-only**: it never approves or answers for you. It delegates
every decision to the normal answerers and alerts only when the request is still pending
after 400 ms; identical alerts are de-duplicated for 4 seconds.

**macOS:** a bundled native notifier (`bin/DSHHumanAlert.app`, universal Apple Silicon +
Intel binary) posts the banner with its own notification permission. **Clicking a banner
brings DeepSeek Harness to the front and switches straight to the Session that raised the
alert** — even across multiple running tasks. Falls back to `osascript` if the helper is
unavailable. Linux uses `notify-send`; Windows shows a detached PowerShell message box
(those two platforms focus the window only).

### How click-to-task works (v1.1+)

The notifier is a short-lived process and may already have exited by the time you click,
so macOS cold-launches it again. The target Session id, loopback origin, and a per-process
random nonce travel inside the notification's `userInfo`; on click the helper calls
`GET /dsh-human-alert/focus?session=…&nonce=…` on the Host, which broadcasts the Session
id over a same-origin SSE channel; the plugin's Client half then calls
`uiWorkspace.openSession(sessionId)`. The nonce is the only accepted credential (the
native helper has no browser cookie); routes reject invalid nonces, bad Session ids, and
cross-origin requests.

## Install

Requires DSH `>= 0.2.0-rc.2`. Install the bundle from GitHub:

- Via the plugin manager's **install bundle**, target: `github:heartrude/dsh-human-alert`
- Or by CLI: `dsh plugin add github:heartrude/dsh-human-alert`

To discover it through the **Discover** tab, add a plugin-market index that lists this
repository (DSH ships no built-in index).

### Grant macOS notification permission

The first alert triggers a system prompt — **“DSH Human Alerts” wants to send
notifications** — click **Allow**. No prompt appears or it has no buttons? Enable it
manually at **System Settings → Notifications → DSH Human Alerts → Allow Notifications**
and tick **Banners** and **Sound**.

## Configuration

Defaults are in the bundle patch; override the plugin row's `config` as needed:

| Key | Default | Meaning |
|---|---|---|
| `notifyApprovals` | `true` | Tool-call approval alerts |
| `notifyQuestions` | `true` | `ask_user_question` / plan-review alerts |
| `notifyAuth` | `true` | Account re-login alerts |
| `sound` | `true` | Play the notification sound |
| `bounceDock` | `true` | Dock bounce for the in-process Electron backend |
| `activateApp` | `false` | Raise the Harness window immediately instead of on click |
| `delayMs` | `400` | Wait this long for a fast answer before alerting |
| `debounceMs` | `4000` | Suppress identical alerts within this window |

## Rebuild the notifier from source (maintainers)

```sh
APP=bin/DSHHumanAlert.app
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp notifier-src/Info.plist "$APP/Contents/Info.plist"

swiftc -O -target arm64-apple-macos13  -module-cache-path .build-cache/arm64 \
  -o .build-cache/DSHHumanAlert-arm64 notifier-src/main.swift \
  -framework UserNotifications -framework AppKit
swiftc -O -target x86_64-apple-macos13 -module-cache-path .build-cache/x86_64 \
  -o .build-cache/DSHHumanAlert-x86_64 notifier-src/main.swift \
  -framework UserNotifications -framework AppKit
lipo -create .build-cache/DSHHumanAlert-arm64 .build-cache/DSHHumanAlert-x86_64 \
  -output "$APP/Contents/MacOS/DSHHumanAlert"

iconutil -c icns AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - --identifier com.github.heartrude.dsh-human-alert "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
```

Diagnostics: `"$APP/Contents/MacOS/DSHHumanAlert" --status` prints the authorization
status (0 = not determined, 1 = denied, 2 = authorized) to `/tmp/dsh-notifier.log`.

## Uninstall

Remove the bundle from your profile's plugin manager and delete the notification
permission entry under System Settings → Notifications if desired.

## License

[MIT](LICENSE)

---

## 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 本地插件：当 Agent
**真正需要你介入**时弹出系统级通知，而不是只在页面里静静等待。

- 工具调用等待审批 → 弹「等待你审批工具调用：xxx」
- Agent 向你提问 / 计划确认 → 弹问题标题与正文
- DeepSeek 账号过期 → 弹重新登录提醒

**纯观察者**：不替你批准、不替你回答；400ms 内被自动处理的不弹；相同内容 4 秒去重。
macOS 附带通用原生通知器（Apple Silicon + Intel），**点击横幅不仅把窗口置前，还会直接
切换到发起提醒的那个任务（Session）**——同时跑多个任务也不会找错；
Linux 走 `notify-send`，Windows 走 PowerShell 消息框（这两个平台仅置前窗口）。

### 「点击跳任务」原理（v1.1+）

通知器是秒退的短生命周期进程，点击时 macOS 会冷启动它；目标 Session id、回环 origin
和进程级随机 nonce 封装在通知的 `userInfo` 里，点击后通知器回调 Host 的
`GET /dsh-human-alert/focus?session=…&nonce=…`，Host 再通过同源 SSE 通道广播给页面里的
插件 Client 半，由其调用 `uiWorkspace.openSession(sessionId)` 完成跳转。nonce 是唯一
凭证（原生通知器没有浏览器 Cookie），路由会拒绝错误 nonce、非法 Session id 和跨源请求。

### 安装

需要 DSH `>= 0.2.0-rc.2`：

- 插件管理器「安装 bundle」，目标填：`github:heartrude/dsh-human-alert`
- 或命令行：`dsh plugin add github:heartrude/dsh-human-alert`

首次弹窗时系统会询问「"DSH Human Alerts" 想要发送通知」，点**允许**；若没有弹窗或
按钮异常，到 **系统设置 → 通知 → DSH Human Alerts → 允许通知** 手动开启，并勾选
横幅与声音。
