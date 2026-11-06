/**
 * @local/dsh-human-alert
 *
 * Observation-only Host plugin: raises a native OS alert whenever an agent
 * actually needs the human —
 *   - approval/request          a tool call waits for an approval decision
 *   - user-questions/request    ask_user_question / plan-review waits for input
 *   - deepseek-account/*        the DeepSeek account requires a re-login
 *
 * The two intervention events are answerer waterfalls. This plugin never
 * claims a decision: it calls next() immediately, lets other answerers
 * respond, and only alerts when the request stays pending.
 *
 * macOS notifications come from the bundled native notifier
 * (bin/DSHHumanAlert.app), which has its own bundle id and notification
 * permission. Clicking a banner raises the Harness window AND selects the
 * Session that produced the alert:
 *
 *   banner click
 *     -> notifier GET /dsh-human-alert/focus?session=&nonce=   (loopback)
 *     -> Host broadcasts over SSE /dsh-human-alert/events
 *     -> the plugin's Client half calls uiWorkspace.openSession(sessionId)
 *
 * If the helper is unavailable it falls back to osascript. Linux uses
 * notify-send and Windows a detached PowerShell MessageBox.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

const APP_ID = 'com.deepseek.dsh';
const APP_NAME = 'DeepSeek Harness';
const NOTIFIER_APP = path.join(PLUGIN_DIR, 'bin', 'DSHHumanAlert.app');
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/**
 * Locate the notifier executable. Prefer Info.plist's CFBundleExecutable so
 * the plugin works regardless of how the binary was named at build time;
 * fall back to the known historical names.
 */
function resolveNotifierBinary() {
  const macosDir = path.join(NOTIFIER_APP, 'Contents', 'MacOS');
  const candidates = [];
  try {
    const plist = readFileSync(path.join(NOTIFIER_APP, 'Contents', 'Info.plist'), 'utf8');
    const match = plist.match(
      /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/,
    );
    if (match?.[1]) candidates.push(match[1]);
  } catch {
    /* no Info.plist — use fallbacks */
  }
  candidates.push('DSHHumanAlert', 'DSH Alerts');
  for (const name of candidates) {
    const full = path.join(macosDir, name);
    if (existsSync(full)) return full;
  }
  return null;
}
const TITLE_NEEDS_YOU = 'DeepSeek Harness 需要人工介入';
const TITLE_LOGIN = 'DeepSeek Harness 需要重新登录';
const MAX_BODY = 500;
const ROUTE_EVENTS = '/dsh-human-alert/events';
const ROUTE_FOCUS = '/dsh-human-alert/focus';
const SESSION_ID_MAX = 200;

const DEFAULTS = {
  notifyApprovals: true,
  notifyQuestions: true,
  notifyAuth: true,
  sound: true,
  bounceDock: true, // used only by the in-process Electron backend
  activateApp: false, // raise the Harness window immediately instead of on click
  delayMs: 400, // do not alert if another answerer settles this fast
  debounceMs: 4000, // suppress an identical alert within this window
};

function normalizeConfig(input = {}) {
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
  return {
    notifyApprovals: bool(input.notifyApprovals, DEFAULTS.notifyApprovals),
    notifyQuestions: bool(input.notifyQuestions, DEFAULTS.notifyQuestions),
    notifyAuth: bool(input.notifyAuth, DEFAULTS.notifyAuth),
    sound: bool(input.sound, DEFAULTS.sound),
    bounceDock: bool(input.bounceDock, DEFAULTS.bounceDock),
    activateApp: bool(input.activateApp, DEFAULTS.activateApp),
    delayMs: num(input.delayMs, DEFAULTS.delayMs),
    debounceMs: num(input.debounceMs, DEFAULTS.debounceMs),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clampBody(text) {
  const flat = String(text ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
  return flat.length > MAX_BODY ? `${flat.slice(0, MAX_BODY - 1)}…` : flat;
}

function safeSessionId(value) {
  if (typeof value !== 'string') return undefined;
  if (value.length === 0 || value.length > SESSION_ID_MAX) return undefined;
  if (!/^[A-Za-z0-9._:@~-]+$/.test(value)) return undefined;
  return value;
}

/**
 * Loopback focus bridge. The native notifier (a separate process, no browser
 * cookies) proves itself with a per-process random nonce; the GUI's Client
 * half receives the session id over SSE and switches the open conversation.
 */
function createFocusBridge(ctx) {
  const webServer = ctx.get?.('webServer');
  if (!webServer || typeof webServer.register !== 'function') return null;

  const nonce = randomBytes(32).toString('hex');
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();
  const getOrigin = () => {
    try {
      return String(webServer.getOrigin?.() ?? '').replace(/\/+$/, '');
    } catch {
      return '';
    }
  };

  const broadcast = (sessionId) => {
    const frame = `data: ${JSON.stringify({ sessionId })}\n\n`;
    for (const res of clients) {
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
      }
    }
  };

  const send = (res, status, text = '') => {
    try {
      res.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      });
      res.end(text);
    } catch {
      /* response already gone */
    }
  };

  const disposeEvents = webServer.register({
    kind: 'exact',
    path: ROUTE_EVENTS,
    handler: (req, res) => {
      // Same-origin browser clients only (the GUI's Client half).
      const origin = getOrigin();
      const reqOrigin = req.headers.origin;
      if (origin && reqOrigin && reqOrigin !== origin) return send(res, 403, 'forbidden');
      const originHost = (() => {
        try {
          return new URL(origin).host;
        } catch {
          return '';
        }
      })();
      if (originHost && req.headers.host && req.headers.host !== originHost) {
        return send(res, 403, 'forbidden');
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.add(res);
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* closed below */
        }
      }, 25_000);
      const cleanup = () => {
        clearInterval(heartbeat);
        clients.delete(res);
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
    },
  });

  const disposeFocus = webServer.register({
    kind: 'exact',
    path: ROUTE_FOCUS,
    handler: (req, res) => {
      try {
        const url = new URL(req.url ?? '/', getOrigin() || 'http://x');
        const provided = url.searchParams.get('nonce') ?? '';
        const expected = Buffer.from(nonce, 'utf8');
        const actual = Buffer.from(String(provided).slice(0, 128), 'utf8');
        const ok =
          actual.length === expected.length &&
          timingSafeEqual(actual, expected) &&
          url.searchParams.get('session') != null;
        if (!ok) return send(res, 403, 'forbidden');
        const sessionId = safeSessionId(url.searchParams.get('session'));
        if (!sessionId) return send(res, 400, 'bad session');
        broadcast(sessionId);
        return send(res, 204);
      } catch {
        return send(res, 400, 'bad request');
      }
    },
  });

  return {
    nonce,
    get origin() {
      return getOrigin();
    },
    dispose() {
      for (const res of clients) {
        try {
          res.end();
        } catch {
          /* already closed */
        }
      }
      clients.clear();
      disposeEvents();
      disposeFocus();
    },
  };
}

/** Best-effort Electron handle; the Desktop Host is a Node child, so normally absent. */
function loadElectron() {
  try {
    const mod = createRequire(import.meta.url)('electron');
    if (mod && typeof mod === 'object' && typeof mod.Notification === 'function') {
      return mod;
    }
  } catch {
    /* not running inside an Electron main process */
  }
  return null;
}

function runDetached(file, args, extra = {}) {
  try {
    const child = spawn(file, args, { stdio: 'ignore', detached: true, ...extra });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* alerting must never affect the agent loop */
  }
}

function appleScriptQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function powerShellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createNotifier(cfg, getBridge) {
  const electron = loadElectron();
  let bounceId = null;

  function focusWindow() {
    if (!electron) return;
    try {
      const { BrowserWindow, app } = electron;
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
      app.focus?.({ steal: true });
    } catch {
      /* best effort */
    }
  }

  function viaElectron({ title, body }) {
    if (!electron) return false;
    try {
      if (!electron.Notification.isSupported()) return false;
      const notification = new electron.Notification({
        title,
        body: clampBody(body),
        silent: !cfg.sound,
        urgency: 'critical',
      });
      notification.on('click', () => {
        focusWindow();
        if (bounceId != null) {
          try {
            electron.app.dock?.cancelBounce?.(bounceId);
          } catch {
            /* best effort */
          }
          bounceId = null;
        }
      });
      notification.show();
      if (cfg.bounceDock && process.platform === 'darwin') {
        try {
          bounceId = electron.app.dock?.bounce?.('informational') ?? null;
        } catch {
          /* best effort */
        }
      }
      if (cfg.activateApp) focusWindow();
      return true;
    } catch {
      return false;
    }
  }

  /** Bundled native macOS notifier: own bundle id, permission survives upgrades. */
  function viaMacNotifier({ title, body, sessionId }) {
    if (process.platform !== 'darwin') return false;
    const binary = resolveNotifierBinary();
    if (!binary || !existsSync(binary)) return false;
    const args = [
      '--title',
      title,
      '--body',
      clampBody(body),
      '--sound',
      cfg.sound ? '1' : '0',
      '--activate',
      cfg.activateApp ? '1' : '0',
      '--target-bundle',
      APP_ID,
    ];
    // Click-to-session: the notifier calls the loopback focus bridge.
    const bridge = getBridge?.();
    if (sessionId && bridge?.origin) {
      args.push('--session', sessionId, '--origin', bridge.origin, '--nonce', bridge.nonce);
    }
    runDetached(binary, args);
    return true;
  }

  function viaScript({ title, body }) {
    const text = clampBody(body);
    if (process.platform === 'darwin') {
      const statements = [];
      if (cfg.activateApp) {
        statements.push(`tell application id "${APP_ID}" to activate`);
      }
      statements.push(
        `display notification ${appleScriptQuote(text)} with title ${appleScriptQuote(title)}` +
          (cfg.sound ? ` sound name "Ping"` : ''),
      );
      runDetached('/usr/bin/osascript', ['-e', statements.join('\n')]);
      return true;
    }
    if (process.platform === 'linux') {
      const args = ['--app-name=' + APP_NAME, '--expire-time=15000'];
      if (cfg.sound) args.push('--hint=int:urgency:2');
      args.push(title, text);
      runDetached('notify-send', args);
      return true;
    }
    if (process.platform === 'win32') {
      const command =
        'Add-Type -AssemblyName System.Windows.Forms; ' +
        `[System.Windows.Forms.MessageBox]::Show(${powerShellQuote(text)}, ${powerShellQuote(title)}) | Out-Null`;
      runDetached('powershell.exe', ['-NoProfile', '-Command', command]);
      return true;
    }
    return false;
  }

  return (payload) => {
    if (viaElectron(payload)) return;
    if (viaMacNotifier(payload)) return;
    viaScript(payload);
  };
}

/** Creates a de-duplicating gate so parallel identical asks alert once. */
function createDeduper() {
  const recent = new Map();
  return function shouldFire(key, debounceMs) {
    const now = Date.now();
    if (recent.size > 64) {
      for (const [seenKey, at] of recent) {
        if (now - at > debounceMs) recent.delete(seenKey);
      }
    }
    const last = recent.get(key);
    if (last != null && now - last < debounceMs) return false;
    recent.set(key, now);
    return true;
  };
}

function localizedReason(req) {
  const display = req.displayReason;
  if (display && typeof display === 'object') {
    return display.zh ?? display['zh-CN'] ?? display.en ?? '';
  }
  return req.reason ?? '';
}

// No top-level `inject`: a static inject forks the plugin off the root event
// bus, and dsh-scope then hides agent-scoped waterfalls
// (approval/request, user-questions/request) from the forked context. Instead
// stay on the agent-visible context and dynamically wait for webServer via
// ctx.inject() only for the HTTP focus bridge.
export function apply(ctx, rawConfig = {}) {
  const cfg = normalizeConfig(rawConfig);

  // Make sure Launch Services knows the notifier (idempotent, detached).
  if (process.platform === 'darwin' && existsSync(LSREGISTER) && existsSync(NOTIFIER_APP)) {
    runDetached(LSREGISTER, ['-f', NOTIFIER_APP]);
  }

  // The focus bridge only needs webServer; this dynamic child plugin activates
  // once the service exists (and unloads with this plugin's fiber).
  let bridge = null;
  ctx.inject(['webServer'], (webCtx) => {
    bridge = createFocusBridge(webCtx);
    webCtx.effect(() => () => {
      bridge?.dispose();
      bridge = null;
    });
  });

  const notify = createNotifier(cfg, () => bridge);
  const shouldFire = createDeduper();

  const alertOnce = (key, payload) => {
    if (shouldFire(key, cfg.debounceMs)) notify(payload);
  };

  /**
   * Observe an answerer waterfall without claiming it: delegate immediately,
   * wait briefly for a fast answer, alert only while the request is pending.
   */
  const observeWaterfall = (event, build) => {
    ctx.on(event, async (req, next) => {
      // Delegate first and synchronously so downstream answerers (the Web UI)
      // receive the request immediately regardless of what observation does.
      const outcome = next();
      try {
        if (cfg.delayMs > 0) await sleep(cfg.delayMs);
        if (!req?.signal?.aborted) {
          const settled = await Promise.race([
            outcome.then(
              () => true,
              () => true,
            ),
            sleep(0).then(() => false),
          ]);
          if (!settled) {
            const payload = build(req);
            if (payload) alertOnce(payload.key, payload);
          }
        }
      } catch {
        /* alerting must never affect the answerer chain */
      }
      return outcome;
    });
  };

  if (cfg.notifyApprovals) {
    observeWaterfall('approval/request', (req) => {
      const reason = localizedReason(req);
      const body =
        `等待你审批工具调用：${req.toolName ?? 'unknown'}` + (reason ? ` — ${reason}` : '');
      return {
        key: `approval:${req.callId ?? req.toolName ?? 'unknown'}:${reason}`,
        title: TITLE_NEEDS_YOU,
        body,
        sessionId: safeSessionId(req.agent?.id),
      };
    });
  }

  if (cfg.notifyQuestions) {
    observeWaterfall('user-questions/request', (request) => {
      const first = Array.isArray(request.questions) ? request.questions[0] : undefined;
      if (!first) return null;
      const body = first.header ? `${first.header}：${first.question}` : first.question;
      return {
        key: `question:${request.wait?.callId ?? body}`,
        title: TITLE_NEEDS_YOU,
        body: body || 'Agent 正在等待你的回答',
        sessionId: safeSessionId(request.agent?.id),
      };
    });
  }

  if (cfg.notifyAuth) {
    ctx.on('deepseek-account/session-expired', () => {
      alertOnce('auth:session-expired', {
        key: 'auth:session-expired',
        title: TITLE_LOGIN,
        body: 'DeepSeek 账号登录已过期，请重新登录后任务才能继续',
      });
    });
    ctx.on('deepseek-account/model-sign-in-required', () => {
      alertOnce('auth:sign-in-required', {
        key: 'auth:sign-in-required',
        title: TITLE_LOGIN,
        body: '模型请求要求先登录 DeepSeek 账号',
      });
    });
  }
}
