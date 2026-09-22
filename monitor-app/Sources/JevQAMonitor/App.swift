import SwiftUI
import AppKit
import Foundation
import UniformTypeIdentifiers

// Monitor for game-qa: starts `bin/game-qa.cjs run` for the selected scenario of the selected
// project (qa.config.json), pauses/stops it, and polls <project>/<runtimeDir>/{status,feed}.json.
// The headed browser is placed on the right half of the screen and this window on the left half.

func gameQaRoot() -> URL {
    // App.swift -> JevQAMonitor/ -> Sources/ -> monitor-app/ -> game-qa/
    URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
}

enum Project {
    static var configURL: URL = {
        if let p = UserDefaults.standard.string(forKey: "configPath"), FileManager.default.fileExists(atPath: p) {
            return URL(fileURLWithPath: p)
        }
        return gameQaRoot().appendingPathComponent("examples/archer-arena/qa.config.json")
    }() {
        didSet { UserDefaults.standard.set(configURL.path, forKey: "configPath") }
    }
    static var dir: URL { configURL.deletingLastPathComponent() }
    static var json: [String: Any] {
        guard let data = try? Data(contentsOf: configURL) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
    static var name: String { json["name"] as? String ?? dir.lastPathComponent }
    static func resolve(_ key: String, _ fallback: String) -> URL {
        let p = json[key] as? String ?? fallback
        return p.hasPrefix("/") ? URL(fileURLWithPath: p) : dir.appendingPathComponent(p).standardizedFileURL
    }
}

func runtimeDir() -> URL { Project.resolve("runtimeDir", ".game-qa") }
func scenariosDir() -> URL { Project.resolve("scenarios", "scenarios") }

// MARK: - シナリオ

struct Scenario: Identifiable, Hashable {
    let id: String
    let title: String
    let description: String?
    let mode: String // "nav" | "move"
    let path: URL
}

func loadScenarios() -> [Scenario] {
    guard let files = try? FileManager.default.contentsOfDirectory(at: scenariosDir(), includingPropertiesForKeys: nil) else { return [] }
    var result: [Scenario] = []
    for f in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) where f.pathExtension == "json" {
        guard let data = try? Data(contentsOf: f),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        let id = obj["id"] as? String ?? f.deletingPathExtension().lastPathComponent
        let rawMode = obj["mode"] as? String ?? "nav"
        result.append(Scenario(id: id, title: obj["title"] as? String ?? id,
                               description: obj["description"] as? String,
                               mode: rawMode == "combat" ? "move" : rawMode, path: f))
    }
    return result
}

// MARK: - プロセス制御

final class RunnerController: ObservableObject {
    @Published var isRunning = false
    @Published var isPaused = false
    @Published var scenarios: [Scenario] = loadScenarios()
    @Published var selectedScenarioId: String?
    // 判定エンジン(jev: TypeSafeクラウド / laya: ローカルLaya-MLX)。次回起動時も前回の選択を使う
    @Published var provider: String = UserDefaults.standard.string(forKey: "provider") ?? "jev" {
        didSet { UserDefaults.standard.set(provider, forKey: "provider") }
    }
    private var process: Process?

    var selectedScenario: Scenario? {
        scenarios.first { $0.id == selectedScenarioId }
    }

    init() {
        if selectedScenarioId == nil { selectedScenarioId = scenarios.first?.id }
    }

    func chooseProject() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.directoryURL = Project.dir
        panel.message = "qa.config.json を選択"
        if panel.runModal() == .OK, let url = panel.url {
            Project.configURL = url
            selectedScenarioId = nil
            refreshScenarios()
        }
    }

    func refreshScenarios() {
        scenarios = loadScenarios()
        if selectedScenarioId == nil || !scenarios.contains(where: { $0.id == selectedScenarioId }) {
            selectedScenarioId = scenarios.first?.id
        }
    }

    func screenHalves() -> (leftFrame: NSRect, rightPos: (Int, Int), rightSize: (Int, Int)) {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let halfW = screen.width / 2
        let left = NSRect(x: screen.minX, y: screen.minY, width: halfW, height: screen.height)
        let rightPos = (Int(screen.minX + halfW), Int(screen.minY))
        let rightSize = (Int(halfW), Int(screen.height))
        return (left, rightPos, rightSize)
    }

    // 直前セッションの表示("進捗"や"ゲームの構造×Jevの判断"リスト)が新セッション開始後もしばらく
    // 残って見えてしまうのを防ぐため、プレイ開始時は毎回ここで消す(はじめから相当のクリア)。
    func clearSessionFiles() {
        try? FileManager.default.removeItem(at: runtimeDir().appendingPathComponent("status.json"))
        try? FileManager.default.removeItem(at: runtimeDir().appendingPathComponent("feed.json"))
        if let files = try? FileManager.default.contentsOfDirectory(at: runtimeDir(), includingPropertiesForKeys: nil) {
            for f in files where f.pathExtension == "jsonl" {
                try? FileManager.default.removeItem(at: f)
            }
        }
    }

    func start() {
        guard process == nil, let scenario = selectedScenario else { return }
        let (_, rightPos, rightSize) = screenHalves()

        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = [
            "node", gameQaRoot().appendingPathComponent("bin/game-qa.cjs").path, "run",
            "--config=\(Project.configURL.path)", "--scenario=\(scenario.path.path)",
            "--provider=\(provider)",
            "--headed=1",
            "--winpos=\(rightPos.0),\(rightPos.1)",
            "--winsize=\(rightSize.0),\(rightSize.1)",
        ]
        var env = ProcessInfo.processInfo.environment
        env["NODE_PATH"] = "/opt/homebrew/lib/node_modules"
        env["PATH"] = "/opt/homebrew/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
        p.environment = env

        try? FileManager.default.createDirectory(at: runtimeDir(), withIntermediateDirectories: true)
        clearSessionFiles()
        FileManager.default.createFile(atPath: runtimeDir().appendingPathComponent("runner.log").path, contents: nil)
        if let fh = FileHandle(forWritingAtPath: runtimeDir().appendingPathComponent("runner.log").path) {
            p.standardOutput = fh
            p.standardError = fh
        }

        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.isRunning = false
                self?.isPaused = false
                self?.process = nil
            }
        }
        do {
            try p.run()
            process = p
            isRunning = true
            isPaused = false
        } catch {
            print("起動失敗: \(error)")
        }
    }

    func stop() {
        if let p = process {
            if isPaused { kill(p.processIdentifier, SIGCONT) }
            p.terminate()
            process = nil
        }
        isRunning = false
        isPaused = false
    }

    func togglePause() {
        guard let p = process, p.isRunning else { return }
        if isPaused {
            kill(p.processIdentifier, SIGCONT)
            isPaused = false
        } else {
            kill(p.processIdentifier, SIGSTOP)
            isPaused = true
        }
    }

    func restart() {
        if let p = process {
            if isPaused { kill(p.processIdentifier, SIGCONT) }
            p.terminate()
            process = nil
        }
        isRunning = false
        isPaused = false
        clearSessionFiles()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.start()
        }
    }
}

// MARK: - ステータス/フィードのポーリング

final class StatusStore: ObservableObject {
    @Published var raw: [String: Any] = [:]
    @Published var feed: [[String: Any]] = []
    @Published var lastError: String?
    @Published var lastLoadedAt: Date = Date()

    func reload() {
        // ファイルが無い(はじめから直後等)場合は前回値を残さず空に戻す。
        // これをしないと、新セッションの最初の書き込みが来るまで前回セッションの
        // 進捗・フィードが画面に残り続けてしまう。
        if let data = try? Data(contentsOf: runtimeDir().appendingPathComponent("status.json")),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            raw = obj
            lastError = nil
        } else {
            raw = [:]
        }
        if let data = try? Data(contentsOf: runtimeDir().appendingPathComponent("feed.json")),
           let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            feed = arr.reversed()
        } else {
            feed = []
        }
        lastLoadedAt = Date()
    }

    func string(_ key: String) -> String {
        if let v = raw[key] as? String { return v }
        if let v = raw[key] as? NSNumber { return v.stringValue }
        return "-"
    }
    func bool(_ key: String) -> Bool { (raw[key] as? Bool) ?? false }
    func int(_ key: String) -> Int { (raw[key] as? Int) ?? 0 }
}

// MARK: - ウィンドウ配置(画面左半分に固定して、右半分をPlaywrightの見えるブラウザに譲る)

struct WindowPositioner: NSViewRepresentable {
    let frame: NSRect
    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async {
            v.window?.setFrame(frame, display: true)
        }
        return v
    }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

// MARK: - UI

struct ContentView: View {
    @StateObject private var store = StatusStore()
    @StateObject private var controller = RunnerController()
    let timer = Timer.publish(every: 1.0, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            WindowPositioner(frame: controller.screenHalves().leftFrame).frame(width: 0, height: 0)
            header
            scenarioPicker
            controls
            Divider()
            summary
            Divider()
            Text("ゲームの構造 × \(providerName)の判断").font(.subheadline).bold()
            feedList
            if store.string("error") != "-" {
                Text(store.string("error")).font(.caption).foregroundStyle(.red)
            }
            if let err = store.lastError {
                Text(err).font(.caption).foregroundStyle(.red)
            }
        }
        .padding(16)
        .frame(minWidth: 460, minHeight: 560)
        .onAppear { store.reload() }
        .onReceive(timer) { _ in store.reload() }
    }

    var providerName: String { controller.provider == "laya" ? "Laya" : "Jev" }

    var header: some View {
        HStack {
            Circle()
                .fill(controller.isPaused ? Color.orange : (store.bool("running") ? Color.green : Color.gray))
                .frame(width: 12, height: 12)
            Text(controller.isPaused ? "一時停止中" : (store.bool("running") ? "実行中" : "停止中"))
                .font(.headline)
            Spacer()
            Text("session: \(store.string("sessionId"))").font(.caption).foregroundStyle(.secondary)
        }
    }

    var scenarioPicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("プロジェクト").font(.caption).foregroundStyle(.secondary)
                Text(Project.name).font(.caption).bold()
                Spacer()
                Button("変更…") { controller.chooseProject() }
                    .font(.caption)
                    .disabled(controller.isRunning)
            }
            HStack {
                Text("シナリオ").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button(action: { controller.refreshScenarios() }) {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.plain)
                .help("scenarios/ フォルダを再読込")
            }
            Picker("", selection: Binding(
                get: { controller.selectedScenarioId ?? "" },
                set: { controller.selectedScenarioId = $0 }
            )) {
                ForEach(controller.scenarios) { s in
                    Text("\(s.title)").tag(s.id)
                }
            }
            .labelsHidden()
            .disabled(controller.isRunning)
            HStack {
                Text("判定AI").font(.caption).foregroundStyle(.secondary)
                Picker("", selection: $controller.provider) {
                    Text("Jev (クラウド)").tag("jev")
                    Text("Laya (ローカルMLX)").tag("laya")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .disabled(controller.isRunning)
            }
            if let d = controller.selectedScenario?.description {
                Text(d).font(.caption2).foregroundStyle(.secondary).lineLimit(3)
            }
        }
    }

    var controls: some View {
        HStack(spacing: 10) {
            Button(action: { controller.isRunning ? controller.togglePause() : controller.start() }) {
                Label(controller.isPaused ? "プレイ" : (controller.isRunning ? "一時停止" : "プレイ"),
                      systemImage: controller.isPaused ? "play.fill" : (controller.isRunning ? "pause.fill" : "play.fill"))
            }
            .disabled(controller.selectedScenario == nil)
            Button(action: { controller.restart() }) {
                Label("はじめから", systemImage: "arrow.counterclockwise")
            }
            .disabled(controller.selectedScenario == nil)
            if controller.isRunning {
                Button(action: { controller.stop() }) {
                    Label("停止", systemImage: "stop.fill")
                }
            }
        }
        .buttonStyle(.bordered)
    }

    var summary: some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 16, verticalSpacing: 4) {
            GridRow {
                Text("進捗").foregroundStyle(.secondary)
                Text("\(store.int("step")) / \(store.int("steps"))").bold()
                Text("シーン").foregroundStyle(.secondary)
                Text(store.string("scene")).bold()
            }
            GridRow {
                Text("エラー").foregroundStyle(.secondary)
                Text(store.string("errors")).bold()
                Text("モデル").foregroundStyle(.secondary)
                Text(store.string("model")).bold().lineLimit(1)
            }
            GridRow {
                Text("判定時間").foregroundStyle(.secondary)
                Text(store.string("latencyMs") == "-" ? "-" : "\(store.string("latencyMs"))ms").bold()
                Text("中央値").foregroundStyle(.secondary)
                Text(store.string("medianLatencyMs") == "-" ? "-" : "\(store.string("medianLatencyMs"))ms").bold()
            }
        }
        .font(.callout)
    }

    var feedList: some View {
        List(Array(store.feed.enumerated()), id: \.offset) { _, item in
            let structure = (item["structure"] as? [String]) ?? []
            let step = (item["step"] as? Int) ?? 0
            let scene = (item["scene"] as? String) ?? "-"
            let chosen = (item["chosenLabel"] as? String) ?? "-"
            let confidence = (item["confidence"] as? Double)
            let noul = (item["noul"] as? Double)

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("#\(step)").font(.caption).bold().foregroundStyle(.secondary)
                    Text(scene).font(.caption).bold()
                    Spacer()
                    if let c = confidence { Text("conf \(String(format: "%.2f", c))").font(.caption2).foregroundStyle(.secondary) }
                    if let n = noul { Text("noul \(String(format: "%.2f", n))").font(.caption2).foregroundStyle(.secondary) }
                }
                Text("構造: " + structure.joined(separator: ", "))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Text("\(providerName)の判断 → \(chosen)")
                    .font(.callout)
                    .bold()
            }
            .padding(.vertical, 4)
        }
        .listStyle(.plain)
    }
}

@main
struct JevQAMonitorApp: App {
    var body: some Scene {
        WindowGroup("Jev QA Monitor") {
            ContentView()
        }
    }
}
