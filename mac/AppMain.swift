// CONTROLGUI — нативное окно macOS (Cocoa + WKWebView).
// Поднимает встроенную node-панель и показывает её в НАСТОЯЩЕМ окне приложения,
// а не во вкладке браузера. Компилируется на macOS: swiftc -O AppMain.swift
// -framework Cocoa -framework WebKit. Доп. зависимостей у пользователя нет.
//
// Клиент-режим: если в данных лежит файл remote-connect (его пишет
// «controlgui connect <url>» или настройки панели), окно открывает УДАЛЁННУЮ
// панель (https://ip:8433, самоподписанный серт с TOFU-пином) и локальный node
// не запускается.
import Cocoa
import CryptoKit
import WebKit

let PORT = ProcessInfo.processInfo.environment["CONTROLGUI_PORT"] ?? "8400"
let DATA_DIR = ProcessInfo.processInfo.environment["CONTROLGUI_DATA"]
    ?? (NSHomeDirectory() + "/Library/Application Support/CONTROLGUI")

// адрес удалённой панели (клиент-режим) — общий файл с CLI: <данные>/data/remote-connect
func remoteUrl() -> String? {
    let p = DATA_DIR + "/data/remote-connect"
    guard let raw = try? String(contentsOfFile: p, encoding: .utf8) else { return nil }
    let url = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return (url.hasPrefix("http://") || url.hasPrefix("https://")) ? url : nil
}

let REMOTE = remoteUrl()
let CLIENT_MODE = REMOTE != nil
let URL_STR = REMOTE ?? "http://127.0.0.1:\(PORT)"

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var node: Process?          // только если node стартовали МЫ (иначе nil — не глушим чужую панель)
    var started = false

    func applicationDidFinishLaunching(_ note: Notification) {
        buildWindow()
        if CLIENT_MODE {
            if let u = URL(string: URL_STR) { webView.load(URLRequest(url: u)) }
        } else {
            startPanelIfNeeded()
            waitForPanelThenLoad()
        }
    }

    // .../Contents/MacOS/controlgui  ->  .../Contents/Resources
    func resourcesDir() -> String {
        let exe = Bundle.main.executablePath ?? CommandLine.arguments[0]
        let macos = (exe as NSString).deletingLastPathComponent
        let contents = (macos as NSString).deletingLastPathComponent
        return contents + "/Resources"
    }

    // спавним node ТОЛЬКО если панель ещё не отвечает на порту (иначе подключаемся к уже живой,
    // а на выходе не трогаем чужой процесс — node остаётся nil)
    func startPanelIfNeeded() {
        if panelUp() { return }
        let res = resourcesDir()
        let nodeBin = res + "/bin/node"
        let appSrc = res + "/opt/controlgui"
        let env0 = ProcessInfo.processInfo.environment
        let data = env0["CONTROLGUI_DATA"] ?? DATA_DIR
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
        // node сам корректно завершится, если этот процесс (родитель) умрёт ненормально
        env["CONTROLGUI_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        p.environment = env

        let logPath = data + "/panel.log"
        FileManager.default.createFile(atPath: logPath, contents: nil)
        if let fh = FileHandle(forWritingAtPath: logPath) {
            p.standardOutput = fh
            p.standardError = fh
        }
        do { try p.run(); node = p; started = true }
        catch { NSLog("CONTROLGUI: не удалось запустить панель: \(error)") }
    }

    func buildWindow() {
        let cfg = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        let style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable]
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1380, height: 900),
                          styleMask: style, backing: .buffered, defer: false)
        window.title = CLIENT_MODE ? "CONTROLGUI — удалённая панель" : "CONTROLGUI"
        window.minSize = NSSize(width: 900, height: 600)
        window.center()
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        showMessage(title: "CONTROLGUI", text: CLIENT_MODE ? "Подключение к удалённой панели…" : "Запуск панели…")
    }

    func showMessage(title: String, text: String) {
        webView.loadHTMLString(
            "<html><body style='background:#1b1b1c;color:#80da5b;margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,Segoe UI,sans-serif'><div style='text-align:center;max-width:520px;padding:24px'><div style='font-size:20px;font-weight:700'>\(title)</div><div style='opacity:.75;margin-top:10px;line-height:1.5'>\(text)</div></div></body></html>",
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
            var up = false
            while i < 160 { if self.panelUp() { up = true; break }; Thread.sleep(forTimeInterval: 0.25); i += 1 }
            DispatchQueue.main.async {
                if up, let u = URL(string: URL_STR) { self.webView.load(URLRequest(url: u)) }
                else {
                    self.showMessage(title: "Панель не запустилась",
                        text: "Не удалось поднять локальную панель на порту \(PORT). Загляните в журнал:<br><code>~/Library/Application Support/CONTROLGUI/panel.log</code>")
                }
            }
        }
    }

    // наши адреса (локальная панель или удалённая) грузим в окне; внешние ссылки — в браузер
    func isOurs(_ url: URL?) -> Bool {
        let h = url?.host ?? ""
        if h == "" { return true } // about:blank/data: (наш сплеш)
        if h == "127.0.0.1" || h == "localhost" { return true }
        if CLIENT_MODE, let remoteHost = URL(string: URL_STR)?.host, h == remoteHost { return true }
        return false
    }

    func webView(_ wv: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let u = action.request.url
        if action.navigationType == .linkActivated && !isOurs(u), let url = u {
            NSWorkspace.shared.open(url) // внешняя ссылка -> системный браузер
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // window.open / target=_blank: внешние — в браузер, наши — в той же вьюхе
    func webView(_ wv: WKWebView, createWebViewWith cfg: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = action.request.url {
            if isOurs(u) { wv.load(URLRequest(url: u)) } else { NSWorkspace.shared.open(u) }
        }
        return nil
    }

    // ---- самоподписанный серт удалённой панели: TOFU-пин отпечатка (SHA-256 DER) ----

    func pinsPath() -> String { return DATA_DIR + "/data/gui-known-hosts.json" }
    func loadPins() -> [String: String] {
        guard let d = FileManager.default.contents(atPath: pinsPath()),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: String] else { return [:] }
        return j
    }
    func savePin(_ key: String, _ fp: String) {
        var pins = loadPins()
        pins[key] = fp
        try? FileManager.default.createDirectory(atPath: (pinsPath() as NSString).deletingLastPathComponent,
                                                 withIntermediateDirectories: true)
        if let d = try? JSONSerialization.data(withJSONObject: pins, options: [.prettyPrinted]) {
            try? d.write(to: URL(fileURLWithPath: pinsPath()))
        }
    }

    func webView(_ wv: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard CLIENT_MODE,
              challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        // отпечаток листового серта (macOS 12+ — новый API, старее — прежний)
        var leafOpt: SecCertificate?
        if #available(macOS 12.0, *) {
            leafOpt = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first
        } else {
            leafOpt = SecTrustGetCertificateAtIndex(trust, 0)
        }
        guard let leaf = leafOpt else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let der = SecCertificateCopyData(leaf) as Data
        let fp = SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
        let key = challenge.protectionSpace.host + ":" + String(challenge.protectionSpace.port)
        let known = loadPins()[key]
        if known == fp {
            completionHandler(.useCredential, URLCredential(trust: trust))
            return
        }
        if known == nil {
            // первый раз: подтверждение отпечатка пользователем
            DispatchQueue.main.async {
                let alert = NSAlert()
                alert.messageText = "Первое подключение к \(key)"
                alert.informativeText = "Отпечаток сертификата (SHA-256):\n\(fp)\n\nСверьте с показанным в панели (Настройки → Удалённый доступ)."
                alert.addButton(withTitle: "Доверять")
                alert.addButton(withTitle: "Отмена")
                if alert.runModal() == .alertFirstButtonReturn {
                    self.savePin(key, fp)
                    completionHandler(.useCredential, URLCredential(trust: trust))
                } else {
                    completionHandler(.cancelAuthenticationChallenge, nil)
                }
            }
            return
        }
        // отпечаток изменился — блокируем и объясняем
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = "ОТПЕЧАТОК СЕРТИФИКАТА ИЗМЕНИЛСЯ"
            alert.informativeText = "Сертификат \(key) не совпадает с сохранённым. Если вы перевыпускали серт — удалите запись в\n\(self.pinsPath())\nИначе это может быть перехват трафика."
            alert.addButton(withTitle: "Понятно")
            alert.runModal()
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    func webView(_ wv: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showMessage(title: "Не удалось открыть панель", text: "Ошибка: \(error.localizedDescription)<br>Панель: <code>\(URL_STR)</code>")
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { return true }
    func applicationWillTerminate(_ note: Notification) {
        // глушим node ТОЛЬКО если стартовали его сами (не убиваем чужую/осиротевшую панель)
        if started { node?.terminate() }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
