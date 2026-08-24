import UIKit
import WebKit

final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
    private let allowedPaths: Set<String> = [
        "/web/index.html",
        "/web/proof.js",
        "/web/shipped-proof.js",
        "/pkg/dsh_noise_security_path_proof.js",
        "/pkg/dsh_noise_security_path_proof_bg.wasm",
        "/pkg/dsh_noise_channel.js",
        "/pkg/dsh_noise_channel_bg.wasm",
    ]

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard
            let url = urlSchemeTask.request.url,
            url.host == "proof",
            allowedPaths.contains(url.path),
            let resources = Bundle.main.resourceURL
        else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let file = resources.appendingPathComponent(String(url.path.dropFirst()))
        do {
            let data = try Data(contentsOf: file)
            let mimeType = file.pathExtension == "wasm"
                ? "application/wasm"
                : file.pathExtension == "js" ? "text/javascript" : "text/html"
            let response = HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Length": String(data.count),
                    "Content-Type": mimeType,
                ]
            )!
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } catch {
            urlSchemeTask.didFailWithError(error)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate, WKScriptMessageHandler {
    var window: UIWindow?
    private let assetSchemeHandler = AssetSchemeHandler()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let controller = WKUserContentController()
        controller.add(self, name: "noiseProof")
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.setURLSchemeHandler(assetSchemeHandler, forURLScheme: "dsh-noise")
        let webView = WKWebView(frame: .zero, configuration: configuration)
        let viewController = UIViewController()
        viewController.view = webView
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = viewController
        window.makeKeyAndVisible()
        self.window = window

        guard let page = URL(string: "dsh-noise://proof/web/index.html?runtime=iOS%20WKWebView") else {
            fatalError("Noise proof URL is invalid")
        }
        webView.load(URLRequest(url: page))
        return true
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let report = message.body as? String else { return }
        do {
            let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            try Data(report.utf8).write(to: directory.appendingPathComponent("noise-proof.json"), options: .atomic)
        } catch {
            fatalError("Unable to write Noise proof report: \(error)")
        }
    }
}
