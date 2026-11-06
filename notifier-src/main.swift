import AppKit
import Foundation
import UserNotifications

let LOG_PATH = "/tmp/dsh-notifier.log"
func nlog(_ msg: String) {
    let line = "\(Date()) \(msg)\n"
    if let data = line.data(using: .utf8) {
        if let handle = FileHandle(forWritingAtPath: LOG_PATH) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: URL(fileURLWithPath: LOG_PATH))
        }
    }
}

func argValue(_ args: [String], _ key: String) -> String? {
    guard let index = args.firstIndex(of: key), index + 1 < args.count else {
        return nil
    }
    return args[index + 1]
}

/// Loopback callback carried inside the notification so a click still reaches
/// the Host after a cold relaunch (the helper exits seconds after posting).
struct ClickRoute {
    let session: String
    let origin: String
    let nonce: String

    init?(userInfo: [AnyHashable: Any]) {
        guard let session = userInfo["session"] as? String,
              let origin = userInfo["origin"] as? String,
              let nonce = userInfo["nonce"] as? String else { return nil }
        self.session = session
        self.origin = origin
        self.nonce = nonce
    }

    func fire() {
        guard let base = URLComponents(string: origin),
              let scheme = base.scheme, scheme == "http" || scheme == "https",
              let baseUrl = base.url else {
            nlog("focus callback: bad origin \(origin)")
            return
        }
        var comps = URLComponents(
            url: baseUrl.appendingPathComponent("dsh-human-alert/focus"),
            resolvingAgainstBaseURL: false
        )
        comps?.queryItems = [
            URLQueryItem(name: "session", value: session),
            URLQueryItem(name: "nonce", value: nonce),
        ]
        guard let url = comps?.url else { return }
        let task = URLSession.shared.dataTask(with: url) { _, response, error in
            let code = (response as? HTTPURLResponse)?.statusCode ?? -1
            nlog("focus callback session=\(session) http=\(code) error=\(String(describing: error))")
        }
        task.resume()
    }
}

final class AlertDelegate: NSObject, UNUserNotificationCenterDelegate {
    let targetBundle: String
    var terminating = false

    init(targetBundle: String) {
        self.targetBundle = targetBundle
    }

    // Present a banner even while the helper is the foreground app.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        nlog("willPresent: showing banner+sound")
        return [.banner, .sound]
    }

    // Banner clicked (helper alive, or system cold-launched us for the click):
    // raise the target app and tell the Host which Session to select.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        let route = ClickRoute(userInfo: info)
        nlog("clicked: activating \(targetBundle) focus=\(route != nil)")
        activateTarget()
        route?.fire()
        // Give the HTTP callback time to finish before exiting.
        scheduleTermination(after: 3)
    }

    func activateTarget() {
        if let app = NSRunningApplication.runningApplications(
            withBundleIdentifier: targetBundle
        ).first {
            if app.isHidden { app.unhide() }
            app.activate(options: [.activateAllWindows])
            return
        }
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: targetBundle) {
            NSWorkspace.shared.openApplication(
                at: url,
                configuration: NSWorkspace.OpenConfiguration()
            )
        }
    }

    func scheduleTermination(after seconds: Double) {
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.terminating else { return }
            self.terminating = true
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
                NSApp.terminate(nil)
            }
        }
    }
}

let arguments = CommandLine.arguments
nlog("launch args=\(arguments.dropFirst().joined(separator: " ")) bundle=\(Bundle.main.bundleIdentifier ?? "nil")")

let app = NSApplication.shared
let targetBundle = argValue(arguments, "--target-bundle") ?? "com.deepseek.dsh"
let delegate = AlertDelegate(targetBundle: targetBundle)
let center = UNUserNotificationCenter.current()
center.delegate = delegate

if arguments.contains("--status") {
    center.getNotificationSettings { settings in
        nlog("authorizationStatus=\(settings.authorizationStatus.rawValue)")
        DispatchQueue.main.async { app.terminate(nil) }
    }
    app.run()
    exit(0)
}

// Cold launch without content args happens when the user clicks a delivered
// banner after the short-lived helper already exited. Do NOT post anything:
// wait for the click response (carries the session route in userInfo).
guard let title = argValue(arguments, "--title") else {
    nlog("cold launch without content: activating target, awaiting click route")
    app.setActivationPolicy(.accessory)
    delegate.activateTarget()
    delegate.scheduleTermination(after: 10) // watchdog if no response arrives
    app.run()
    exit(0)
}

let body = argValue(arguments, "--body") ?? ""
let sound = argValue(arguments, "--sound") != "0"
let activate = argValue(arguments, "--activate") == "1"
let session = argValue(arguments, "--session")
let origin = argValue(arguments, "--origin")
let nonce = argValue(arguments, "--nonce")

let content = UNMutableNotificationContent()
content.title = title
content.body = body
content.sound = sound ? .default : nil
content.interruptionLevel = .active
if let session, let origin, let nonce {
    content.userInfo = ["session": session, "origin": origin, "nonce": nonce]
}

let request = UNNotificationRequest(
    identifier: UUID().uuidString,
    content: content,
    trigger: nil
)

// Rate-limited helper: on some macOS setups the in-process authorization
// alert renders without buttons (when the binary is launched outside a normal
// LaunchServices activation). Opening Notifications settings gives the user
// a working one-click path. At most once per 12 hours.
func openNotificationSettingsIfNeeded(force: Bool = false) {
    let dir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/dsh-human-alert", isDirectory: true)
    let stamp = dir.appendingPathComponent(".settings-prompt")
    let interval: TimeInterval = 12 * 60 * 60

    if !force {
        if let attrs = try? FileManager.default.attributesOfItem(atPath: stamp.path),
           let mtime = attrs[.modificationDate] as? Date,
           Date().timeIntervalSince(mtime) < interval {
            nlog("settings prompt within cooldown, skipping")
            return
        }
    }

    let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!
    NSWorkspace.shared.open(url)
    nlog("opened Notifications settings pane")

    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: stamp.path, contents: nil)
}

center.getNotificationSettings { settings in
    nlog("pre-check authorizationStatus=\(settings.authorizationStatus.rawValue)")
    // Already decided: run as a background agent so there is no Dock bounce.
    if settings.authorizationStatus != .notDetermined {
        DispatchQueue.main.async { app.setActivationPolicy(.accessory) }
    }
    if settings.authorizationStatus == .denied {
        // A working toggle exists in System Settings; lead the user there.
        openNotificationSettingsIfNeeded()
        DispatchQueue.main.async { app.terminate(nil) }
        return
    }
    if settings.authorizationStatus == .notDetermined {
        // Belt and suspenders: the in-process alert may be buttonless in this
        // launch context; the settings pane guarantees an actionable toggle.
        openNotificationSettingsIfNeeded()
    }
    // First run: stay a regular app so the system permission alert shows
    // its Allow / Don't Allow buttons (agent apps get a buttonless alert).
    center.requestAuthorization(options: [.alert, .sound]) { granted, error in
        nlog("requestAuthorization granted=\(granted) error=\(String(describing: error))")
        guard granted else {
            DispatchQueue.main.async { app.terminate(nil) }
            return
        }
        center.add(request) { addError in
            nlog("notification added error=\(String(describing: addError))")
            if activate { delegate.activateTarget() }
            // Hide from Dock shortly after first-run authorization.
            DispatchQueue.main.async { app.setActivationPolicy(.accessory) }
            delegate.scheduleTermination(after: 4)
        }
    }
}

app.run()
