// CONTROLGUI — нативное окно macOS (Cocoa + WKWebView).
// Поднимает встроенную node-панель и показывает её в НАСТОЯЩЕМ окне приложения,
// а не во вкладке браузера. Компилируется на macOS: swiftc -O AppMain.swift
// -framework Cocoa -framework WebKit. Доп. зависимостей у пользователя нет.
import Cocoa
import WebKit

let PORT = ProcessInfo.processInfo.environment["CONTROLGUI_PORT"] ?? "8400"
let URL_STR = "http://127.0.0.1:\(PORT)"

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var node: Process?

    func applicationDidFinishLaunching(_ note: Notification) {
        startPanel()
        buildWindow()
        waitForPanelThenLoad()
    }

    // .../Contents/MacOS/controlgui  ->  .../Contents/Resources
    func resourcesDir() -> String {
        let exe = Bundle.main.executablePath ?? CommandLine.arguments[0]
        let macos = (exe as NSString).deletingLastPathComponent
        let contents = (macos as NSString).deletingLastPathComponent
        return contents + "/Resources"
    }

    func startPanel() {
        let res = resourcesDir()
        let nodeBin = res + "/bin/node"
        let appSrc = res + "/opt/controlgui"
        let env0 = ProcessInfo.processInfo.environment
        let data = env0["CONTROLGUI_DATA"] ?? (NSHomeDirectory() + "/Library/Application Support/CONTROLGUI")
        try? FileManager.default.createDirectory(atPath: data, withIntermediateDirectories: true)

        let p = Process()
        if FileManager.default.isExecutableFile(atPath: nodeBin) {
            p.executableURL = URL(fileURLWithPath: nodeBin)
            p.arguments = ["server.js"]
        } else {
            p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            p.arguments = ["node", "server.js"]
        }
        p.currentDirectoryURL = URL(fileURLWithPath: appSrc)
        var env = env0
        env["PORT"] = PORT
        env["CONTROLGUI_DATA"] = data
        p.environment = env

        let logPath = data + "/panel.log"
        FileManager.default.createFile(atPath: logPath, contents: nil)
        if let fh = FileHandle(forWritingAtPath: logPath) {
            p.standardOutput = fh
            p.standardError = fh
        }
        do { try p.run(); node = p } catch { NSLog("CONTROLGUI: не удалось запустить панель: \(error)") }
    }

    func buildWindow() {
        let cfg = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        let style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable]
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1380, height: 900),
                          styleMask: style, backing: .buffered, defer: false)
        window.title = "CONTROLGUI"
        window.minSize = NSSize(width: 900, height: 600)
        window.center()
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        // заставка, пока панель поднимается
        webView.loadHTMLString(
            "<html><body style='background:#1b1b1c;color:#80da5b;margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,Segoe UI,sans-serif'><div style='text-align:center'><div style='font-size:20px;font-weight:700'>CONTROLGUI</div><div style='opacity:.7;margin-top:8px'>Запуск панели…</div></div></body></html>",
            baseURL: nil)
    }

    func panelUp() -> Bool {
        guard let url = URL(string: URL_STR + "/") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.0
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            if let h = resp as? HTTPURLResponse, h.statusCode > 0 { ok = true }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 1.5)
        return ok
    }

    func waitForPanelThenLoad() {
        DispatchQueue.global().async {
            var i = 0
            while i < 160 { if self.panelUp() { break }; Thread.sleep(forTimeInterval: 0.25); i += 1 }
            DispatchQueue.main.async {
                if let u = URL(string: URL_STR) { self.webView.load(URLRequest(url: u)) }
            }
        }
    }

    // ссылки target=_blank открываем в той же вьюхе (панель — одностраничник)
    func webView(_ wv: WKWebView, createWebViewWith cfg: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = action.request.url { wv.load(URLRequest(url: u)) }
        return nil
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { return true }
    func applicationWillTerminate(_ note: Notification) { node?.terminate() }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
