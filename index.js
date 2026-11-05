/**
 * dsh-human-alert
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
 * permission; clicking its banner raises the Harness window. If the helper
 * is unavailable it falls back to osascript. Linux uses notify-send and
 * Windows a detached PowerShell MessageBox.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const APP_ID = 'com.deepseek.dsh';
const APP_NAME = 'DeepSeek Harness';
const NOTIFIER_APP = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'bin',
  'DSHHumanAlert.app',
);
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const TITLE_NEEDS_YOU = 'DeepSeek Harness 需要人工介入';
const TITLE_LOGIN = 'DeepSeek Harness 需要重新登录';
const MAX_BODY = 500;

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

function createNotifier(cfg) {
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
  function viaMacNotifier({ title, body }) {
    if (process.platform !== 'darwin') return false;
    const binary = path.join(NOTIFIER_APP, 'Contents', 'MacOS', 'DSHHumanAlert');
    if (!existsSync(binary)) return false;
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

export function apply(ctx, rawConfig = {}) {
  const cfg = normalizeConfig(rawConfig);

  // Make sure Launch Services knows the notifier (idempotent, detached).
  if (process.platform === 'darwin' && existsSync(LSREGISTER) && existsSync(NOTIFIER_APP)) {
    runDetached(LSREGISTER, ['-f', NOTIFIER_APP]);
  }

  const notify = createNotifier(cfg);
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
