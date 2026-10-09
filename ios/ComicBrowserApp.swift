import SwiftUI
import WebKit
import UIKit

private enum TranslationEngine: String, CaseIterable, Identifiable {
    case onDevice
    case cloud

    var id: String { rawValue }
    var title: String {
        switch self {
        case .onDevice: return "本机翻译 · ML Kit"
        case .cloud: return "云端翻译 · OpenAI"
        }
    }
}

@main
@MainActor
struct ComicBrowserApp: App {
    var body: some Scene { WindowGroup { BrowserScreen() } }
}

@MainActor
private struct BrowserScreen: View {
    @StateObject private var browser = BrowserModel()
    @State private var address = "https://mangadex.org/title/49650a04-d0d7-4526-b460-8203ae223586"
    @State private var settingsVisible = false
    @FocusState private var addressFocused: Bool
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                TextField("漫画目录网址", text: $address)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .keyboardType(.URL).submitLabel(.go).focused($addressFocused)
                    .onSubmit(openAddress)
                Button(action: openAddress) { Image(systemName: "arrow.right.circle.fill") }
                    .accessibilityLabel("打开网址")
                Button { settingsVisible = true } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("翻译设置")
            }.padding(10).background(.regularMaterial)
            WebBrowserView(model: browser)
            VStack(alignment: .leading, spacing: 3) {
                Text(browser.status).font(.caption).lineLimit(3)
                if browser.engine == .onDevice && browser.translationVisible {
                    Link("Powered by Google Translate", destination: URL(string: "https://translate.google.com/")!)
                        .font(.caption2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(8)
            .background(.regularMaterial)
            HStack(spacing: 12) {
                Button(action: browser.back) { Image(systemName: "chevron.left") }
                    .disabled(!browser.canGoBack).accessibilityLabel("返回目录或上一页")
                Button(action: browser.forward) { Image(systemName: "chevron.right") }
                    .disabled(!browser.canGoForward).accessibilityLabel("前进")
                Button(action: browser.reload) { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("刷新原网页")
                Spacer(minLength: 0)
                Toggle("中文", isOn: Binding(get: { browser.translationVisible }, set: browser.setTranslationVisible))
                    .fixedSize().font(.callout)
                Toggle("自动", isOn: Binding(get: { browser.autoTranslate }, set: browser.setAutoTranslate))
                    .fixedSize().font(.callout)
                if browser.isTranslating {
                    Button("取消", action: browser.cancelTranslation)
                } else {
                    Button("设置") { settingsVisible = true }
                }
            }.padding(12).background(.regularMaterial)
        }
        .onChange(of: browser.currentURL) { value in
            if !addressFocused, !value.isEmpty { address = value }
        }
        .onAppear { browser.setForeground(scenePhase == .active) }
        .onChange(of: scenePhase) { browser.setForeground($0 == .active) }
        .onChange(of: settingsVisible) { browser.setSettingsVisible($0) }
        .onChange(of: browser.engine) { _ in browser.translationConfigurationChanged() }
        .onChange(of: browser.apiKey) { _ in browser.translationConfigurationChanged() }
        .onChange(of: browser.modelName) { _ in browser.translationConfigurationChanged() }
        .sheet(isPresented: $settingsVisible) {
            NavigationStack {
                Form {
                    Section("英文 → 简体华文") {
                        Picker("翻译方式", selection: $browser.engine) {
                            ForEach(TranslationEngine.allCases) { option in
                                Text(option.title).tag(option)
                            }
                        }
                        if browser.engine == .onDevice {
                            Text("默认使用 ML Kit 在设备上识别英文并翻译成华文。首次使用需通过 Wi-Fi 下载语言模型；之后翻译无需 API Key，也不会产生按页 API 费用。")
                                .font(.caption)
                            Link("翻译由 Google Translate 提供", destination: URL(string: "https://translate.google.com/")!)
                                .font(.caption)
                        } else {
                            SecureField("OpenAI API Key", text: $browser.apiKey)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                            TextField("支持图片和结构化输出的模型名称", text: $browser.modelName)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                            Text("云端模式会把当前可见漫画截图送往 OpenAI，产生 API 费用。Key 只保留在本次 App 会话，不注入网页。")
                                .font(.caption)
                        }
                    }
                    Section("使用") {
                        Text("打开漫画目录网址，使用原网站选择章节。翻页或滚动后停住，自动翻译当前画面；已识别的目录、未加载完成的漫画图不会自动请求。关闭「自动」或「中文」会暂停。")
                        Text("本机模式只覆盖背景平整、位置可安全判断的英文对白；小字、纹理背景和复杂对白会保留原图。原网站返回、目录和下一章链接照常使用。")
                        Text("错误会关闭自动翻译；修正设置后重新打开「自动」。云端模式不会自动重复可能收费的请求。")
                    }
                    Button("重新翻译当前画面") {
                        settingsVisible = false
                        browser.retryCurrentScreen()
                    }.disabled((browser.engine == .cloud && (browser.apiKey.isEmpty || browser.modelName.isEmpty)) || browser.isLoading || browser.webView.url == nil)
                    if browser.engine == .cloud { Button("清除 Key") { browser.apiKey = "" } }
                    Button("清除当前网页译文", action: browser.clearTranslations)
                }
                .navigationTitle("翻译设置")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { settingsVisible = false } } }
            }
        }
    }

    private func openAddress() {
        addressFocused = false
        browser.open(address)
    }
}

@MainActor
private struct WebBrowserView: UIViewRepresentable {
    @ObservedObject var model: BrowserModel
    func makeUIView(context: Context) -> WKWebView { model.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

private struct ViewportStamp: Codable {
    let href: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let scale: Double
    let signature: String
    let revision: Int
    let comicCandidate: Bool
    let comicRects: [TranslationRect]
    let pendingImages: Int

    func matches(_ other: ViewportStamp) -> Bool {
        href == other.href && signature == other.signature && revision == other.revision &&
        abs(x - other.x) < 1 && abs(y - other.y) < 1 &&
        abs(width - other.width) < 1 && abs(height - other.height) < 1 &&
        abs(scale - other.scale) < 0.001
    }
    // Revision rejects a scroll-away-and-back response; it is intentionally excluded from cache identity.
    var cacheKey: String {
        [href, signature, String(x.rounded()), String(y.rounded()), String(width.rounded()),
         String(height.rounded()), String(scale)].joined(separator: "\u{001F}")
    }
    var isValid: Bool {
        [x, y, width, height, scale].allSatisfy { $0.isFinite } &&
        x >= 0 && y >= 0 && width > 0 && height > 0 && scale > 0 &&
        width <= 10000 && height <= 10000 && comicRects.count <= 40 &&
        comicRects.allSatisfy(\.isValid)
    }
}

@MainActor
private final class BrowserModel: NSObject, ObservableObject, WKNavigationDelegate {
    let webView: WKWebView
    @Published var currentURL = ""
    @Published var canGoBack = false
    @Published var canGoForward = false
    @Published var isLoading = false
    @Published var isTranslating = false
    @Published var translationVisible = true
    @Published var autoTranslate = true
    @Published var engine: TranslationEngine = .onDevice
    @Published var apiKey = ""
    @Published var modelName = ""
    @Published var status = "输入漫画目录网址并回车，使用原网站选章节。"
    private var observations = [NSKeyValueObservation]()
    private var translationTask: Task<Void, Never>?
    private var operationID: UUID?
    private let overlaySource: String
    private var monitorTask: Task<Void, Never>?
    private var isForeground = false
    private var settingsVisible = false
    private var previousStamp: ViewportStamp?
    private var stableSince = Date()
    private var activeStamp: ViewportStamp?
    private var handledKey: String?
    private var configurationID = UUID()
    private var attemptedKeys = Set<String>()
    private var cachedResults = [String: TranslationResult]()
    private var captureInProgress = false
    private var retryPending = false

    override init() {
        let config = WKWebViewConfiguration()
        // No native message handler is exposed to untrusted websites.
        config.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: config)
        if let overlayURL = Bundle.main.url(forResource: "Overlay", withExtension: "js") {
            overlaySource = (try? String(contentsOf: overlayURL, encoding: .utf8)) ?? ""
        } else { overlaySource = "" }
        super.init()
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        observations = [
            webView.observe(\.url, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in self?.refreshNavigationState() }
            },
            webView.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in self?.refreshNavigationState() }
            },
            webView.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in self?.refreshNavigationState() }
            }
        ]
    }

    private var canAutomaticallyTranslate: Bool {
        autoTranslate && translationVisible && isForeground && !settingsVisible && !isLoading &&
        webView.url != nil && (engine == .onDevice ||
        (!apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
         !modelName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
    }

    func setForeground(_ value: Bool) {
        isForeground = value
        resetStability()
        if value {
            startMonitor()
        } else {
            monitorTask?.cancel(); monitorTask = nil
            stopTranslation()
        }
    }

    func setSettingsVisible(_ value: Bool) {
        settingsVisible = value
        if value { stopTranslation() }
        resetStability()
        if !value { showReadiness() }
    }

    func setAutoTranslate(_ value: Bool) {
        autoTranslate = value
        if !value { stopTranslation() }
        resetStability()
        status = value ? "自动翻译已开启；停住约 1 秒后翻译当前漫画画面。" : "自动翻译已暂停，原站可以继续阅读。"
        if value { showReadiness() }
    }

    func translationConfigurationChanged() {
        stopTranslation()
        configurationID = UUID()
        handledKey = nil
        cachedResults.removeAll(); attemptedKeys.removeAll()
        retryPending = false
        resetStability()
        Task { _ = try? await overlay("clear()") }
    }

    private func resetStability() {
        previousStamp = nil
        stableSince = Date()
        handledKey = nil
    }

    private func showReadiness() {
        if engine == .cloud && (apiKey.isEmpty || modelName.isEmpty) {
            status = "打开「设置」填写 API Key 和模型；完成后自动翻译，无需逐页点击。"
        } else if autoTranslate && translationVisible {
            status = engine == .onDevice
                ? "本机自动翻译已开启；停住约 1 秒后识别当前漫画画面。首次使用需下载语言模型。"
                : "云端自动翻译已开启；停住约 1 秒后翻译当前漫画画面。"
        }
    }

    private func startMonitor() {
        guard monitorTask == nil else { return }
        monitorTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 300_000_000)
                guard !Task.isCancelled else { break }
                guard self != nil else { break }
                await self?.checkAutomaticTranslation()
            }
        }
    }

    private func checkAutomaticTranslation() async {
        guard canAutomaticallyTranslate else { return }
        do {
            let current = try await stamp()
            guard canAutomaticallyTranslate else { return }
            if let activeStamp, !activeStamp.matches(current) { stopTranslation() }
            guard current.isValid, current.comicCandidate, current.pendingImages == 0 else {
                previousStamp = nil
                stableSince = Date()
                return
            }
            guard let previous = previousStamp, previous.matches(current) else {
                previousStamp = current
                stableSince = Date()
                handledKey = nil
                return
            }
            guard !isTranslating, !captureInProgress, Date().timeIntervalSince(stableSince) >= 0.9 else { return }
            let cacheKey = configurationID.uuidString + current.cacheKey
            if retryPending {
                cachedResults.removeValue(forKey: cacheKey)
                attemptedKeys.remove(cacheKey)
                retryPending = false
                handledKey = nil
            }
            guard handledKey != cacheKey else { return }
            handledKey = cacheKey
            if let result = cachedResults[cacheKey] {
                let applied = try await apply(result, at: current)
                guard canAutomaticallyTranslate else { return }
                status = applied > 0 ? "此屏已恢复缓存华文，没有重新翻译。" : "此屏没有可安全排字的对白。"
                return
            }
            guard !attemptedKeys.contains(cacheKey) else {
                status = "此画面已请求过云端翻译，自动模式不会重复收费；需要重试时可在设置里重新翻译。"
                return
            }
            translateCurrentScreen(expected: current, cacheKey: cacheKey)
        } catch is CancellationError {
            resetStability()
        } catch {
            pauseAfterError(error)
        }
    }

    func retryCurrentScreen() {
        stopTranslation()
        // Retry only the next stable viewport, preserving every other screen's cached result.
        retryPending = true
        resetStability()
        translationVisible = true
        autoTranslate = true
        status = engine == .onDevice
            ? "当前画面将在本机重新识别和翻译。"
            : "当前画面将重新翻译；停住后会产生新的 API 请求。"
    }

    private func pauseAfterError(_ error: Error) {
        autoTranslate = false
        stopTranslation()
        status = ((error as? ReaderError)?.localizedDescription ?? "翻译或网页操作失败。") + " 自动翻译已暂停；检查设置后重新打开「自动」。"
    }

    func open(_ value: String) {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let address = text.contains("://") ? text : "https://" + text
        guard let url = URL(string: address), Self.allowed(url) else {
            status = "请输入完整 HTTPS 漫画网址。"
            return
        }
        stopTranslation()
        webView.load(URLRequest(url: url))
    }

    private static func allowed(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && !(url.host ?? "").isEmpty &&
        url.user == nil && url.password == nil
    }

    func back() { stopTranslation(); resetStability(); webView.goBack() }
    func forward() { stopTranslation(); resetStability(); webView.goForward() }
    func reload() { stopTranslation(); resetStability(); webView.reload() }

    func cancelTranslation() {
        let hadTask = translationTask != nil
        autoTranslate = false
        stopTranslation()
        if hadTask {
            status = engine == .onDevice
                ? "已取消并暂停本机自动翻译。"
                : "已取消并暂停自动翻译；已发送的 API 请求仍可能产生费用。"
        }
    }

    private func stopTranslation() {
        translationTask?.cancel()
        translationTask = nil
        operationID = nil
        activeStamp = nil
        isTranslating = false
    }

    func setTranslationVisible(_ value: Bool) {
        translationVisible = value
        if !value { stopTranslation() }
        resetStability()
        Task { try? await overlay("visibility(\(value ? "true" : "false"))") }
    }

    func clearTranslations() {
        cancelTranslation()
        cachedResults.removeAll(); attemptedKeys.removeAll()
        Task { try? await overlay("clear()") }
        status = "已清除中文叠加，原漫画完整保留。"
    }

    private func translateCurrentScreen(expected: ViewportStamp, cacheKey: String) {
        guard !isTranslating, !captureInProgress, canAutomaticallyTranslate else { return }
        let id = UUID()
        operationID = id
        activeStamp = expected
        isTranslating = true
        status = "正在识别和翻译此屏，请暂时停在当前位置。"
        let key = apiKey
        let model = modelName
        let selectedEngine = engine
        translationTask = Task { [weak self] in
            guard let self = self else { return }
            defer {
                if self.operationID == id {
                    self.isTranslating = false
                    self.translationTask = nil
                    self.operationID = nil
                    self.activeStamp = nil
                }
            }
            do {
                let before = try await self.stamp()
                try Task.checkCancellation()
                guard self.operationID == id else { throw CancellationError() }
                guard before.matches(expected), before.comicCandidate, before.pendingImages == 0 else {
                    throw CancellationError()
                }
                guard before.isValid,
                      self.webView.bounds.width > 0, self.webView.bounds.height > 0 else {
                    throw ReaderError.message("网页还没有完成显示，请稍后重试。")
                }
                let image = try await self.captureOriginal(operation: id)
                let afterSnapshot = try await self.stamp()
                try Task.checkCancellation()
                guard self.operationID == id, self.canAutomaticallyTranslate, before.matches(afterSnapshot) else {
                    throw CancellationError()
                }
                guard image.size.width > 0, image.size.height > 0,
                      image.size.width * image.size.height * image.scale * image.scale <= 12_000_000 else {
                    throw ReaderError.message("无法生成此屏截图。")
                }
                let result: TranslationResult
                switch selectedEngine {
                case .onDevice:
                    let comicRects = expected.comicRects.map { rect in
                        CGRect(x: rect.x / 1000 * image.size.width,
                               y: rect.y / 1000 * image.size.height,
                               width: rect.w / 1000 * image.size.width,
                               height: rect.h / 1000 * image.size.height)
                    }
                    result = try await MLKitTranslationService.translate(image: image, comicRects: comicRects)
                case .cloud:
                    guard let jpeg = image.jpegData(compressionQuality: 0.9) else {
                        throw ReaderError.message("无法生成此屏截图。")
                    }
                    // Record immediately before the paid call, including canceled or empty-result requests.
                    self.attemptedKeys.insert(cacheKey)
                    result = try await TranslationService.translate(jpeg: jpeg, apiKey: key, model: model)
                }
                let afterTranslation = try await self.stamp()
                try Task.checkCancellation()
                guard self.operationID == id, self.canAutomaticallyTranslate, before.matches(afterTranslation) else {
                    throw CancellationError()
                }
                self.cachedResults[cacheKey] = result
                // Keep completed payloads bounded; attempted identities remain to prevent automatic repeats.
                if self.cachedResults.count > 100, let oldKey = self.cachedResults.keys.first(where: { $0 != cacheKey }) {
                    self.cachedResults.removeValue(forKey: oldKey)
                }
                let applied = try await self.apply(result, at: before)
                try Task.checkCancellation()
                guard self.operationID == id else { return }
                _ = try await self.overlay("visibility(\(self.translationVisible ? "true" : "false"))")
                if self.operationID == id {
                    self.status = applied > 0 ? "此屏已叠加 \(applied) 处华文；继续阅读，下一屏会自动翻译。" : "此屏没有可安全排字的完整英文对白，保留原图；此屏不会重复请求。"
                }
            } catch is CancellationError {
                // A canceled operation cannot apply an old result to the new page.
                if self.operationID == id { self.resetStability() }
            } catch {
                if self.operationID == id {
                    self.pauseAfterError(error)
                }
            }
        }
    }

    private func apply(_ result: TranslationResult, at viewport: ViewportStamp) async throws -> Int {
        let payload: [String: Any] = [
            "viewport": try JSONSerialization.jsonObject(with: JSONEncoder().encode(viewport)),
            "regions": try JSONSerialization.jsonObject(with: JSONEncoder().encode(result.regions))
        ]
        let json = try Self.javascriptJSON(payload)
        do {
            return try await overlay("apply(\(json))") as? Int ?? 0
        } catch {
            // A scroll between the stamp check and DOM application is routine cancellation.
            if let now = try? await stamp(), !viewport.matches(now) { throw CancellationError() }
            throw error
        }
    }

    private func captureOriginal(operation id: UUID) async throws -> UIImage {
        guard !captureInProgress, operationID == id else { throw CancellationError() }
        try Task.checkCancellation()
        captureInProgress = true
        defer { captureInProgress = false }
        do {
            _ = try await overlay("visibility(false)")
            try Task.checkCancellation()
            guard operationID == id else { throw CancellationError() }
            let image = try await snapshot()
            _ = try await overlay("visibility(\(translationVisible ? "true" : "false"))")
            try Task.checkCancellation()
            guard operationID == id else { throw CancellationError() }
            return image
        } catch {
            _ = try? await overlay("visibility(\(translationVisible ? "true" : "false"))")
            throw error
        }
    }

    private func stamp() async throws -> ViewportStamp {
        guard let result = try await overlay("state()") else {
            throw ReaderError.message("无法读取网页显示位置。")
        }
        return try JSONDecoder().decode(ViewportStamp.self, from: JSONSerialization.data(withJSONObject: result))
    }

    private func overlay(_ expression: String) async throws -> Any? {
        guard !overlaySource.isEmpty else { throw ReaderError.message("缺少 Overlay.js 应用资源。") }
        let script = overlaySource + "\n;globalThis.__comicTranslationOverlay." + expression
        // Separate JavaScript namespace; DOM overlays themselves are still visible to page scripts.
        return try await withCheckedThrowingContinuation { continuation in
            webView.evaluateJavaScript(script, in: nil, in: .defaultClient) { result in
                switch result {
                case .success(let value): continuation.resume(returning: value)
                case .failure(let error): continuation.resume(throwing: error)
                }
            }
        }
    }

    private func snapshot() async throws -> UIImage {
        let config = WKSnapshotConfiguration()
        config.rect = webView.bounds
        config.snapshotWidth = NSNumber(value: min(1600, Double(webView.bounds.width)))
        config.afterScreenUpdates = true
        return try await withCheckedThrowingContinuation { continuation in
            webView.takeSnapshot(with: config) { image, error in
                if let error = error { continuation.resume(throwing: error) }
                else if let image = image { continuation.resume(returning: image) }
                else { continuation.resume(throwing: ReaderError.message("网页截图失败。")) }
            }
        }
    }

    private static func javascriptJSON(_ object: Any) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard let json = String(data: data, encoding: .utf8) else { throw ReaderError.message("译文编码失败。") }
        return json.replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    private func refreshNavigationState() {
        currentURL = webView.url?.absoluteString ?? ""
        canGoBack = webView.canGoBack
        canGoForward = webView.canGoForward
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, Self.allowed(url) else {
            decisionHandler(.cancel)
            if navigationAction.targetFrame?.isMainFrame != false { status = "此原型只打开 HTTPS 网页链接。" }
            return
        }
        if navigationAction.targetFrame == nil {
            webView.load(navigationAction.request)
            decisionHandler(.cancel)
        } else { decisionHandler(.allow) }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        stopTranslation()
        resetStability()
        isLoading = true
        status = "正在打开原网站…"
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isLoading = false
        refreshNavigationState()
        resetStability()
        showReadiness()
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        stopTranslation(); resetStability(); isLoading = false
        status = "网页进程已停止，可点刷新重新打开。"
    }
    private func failed(_ error: Error) {
        stopTranslation(); resetStability()
        isLoading = false
        if (error as NSError).code != NSURLErrorCancelled { status = "原网站加载失败，请检查网络或稍后刷新。" }
        refreshNavigationState()
    }
}
