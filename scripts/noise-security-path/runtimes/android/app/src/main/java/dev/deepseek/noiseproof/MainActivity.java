package dev.deepseek.noiseproof;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

public final class MainActivity extends Activity {
    @Override
    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setAllowFileAccess(false);
        ProofBridge bridge = new ProofBridge();
        bridge.reportProgress("activity created");
        webView.addJavascriptInterface(bridge, "NoiseProof");
        webView.setWebViewClient(new AssetClient());
        setContentView(webView);
        webView.loadUrl("https://noise-proof.invalid/web/index.html?runtime=Android%20WebView");
    }

    private final class AssetClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (!"noise-proof.invalid".equals(request.getUrl().getHost())) {
                return deniedResponse();
            }
            String path = request.getUrl().getPath();
            if (path == null || !isProofAsset(path)) {
                return deniedResponse();
            }
            try {
                String assetPath = path.substring(1);
                String mimeType = assetPath.endsWith(".wasm")
                    ? "application/wasm"
                    : assetPath.endsWith(".js") ? "text/javascript" : "text/html";
                InputStream input = getAssets().open(assetPath);
                return new WebResourceResponse(mimeType, null, input);
            } catch (IOException error) {
                return deniedResponse();
            }
        }

        private boolean isProofAsset(String path) {
            return path.equals("/web/index.html")
                || path.equals("/web/proof.js")
                || path.equals("/web/shipped-proof.js")
                || path.equals("/pkg/dsh_noise_security_path_proof.js")
                || path.equals("/pkg/dsh_noise_security_path_proof_bg.wasm")
                || path.equals("/pkg/dsh_noise_channel.js")
                || path.equals("/pkg/dsh_noise_channel_bg.wasm");
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            new ProofBridge().reportProgress("page finished: " + url);
        }

        private WebResourceResponse deniedResponse() {
            return new WebResourceResponse(
                "text/plain",
                "UTF-8",
                404,
                "Not Found",
                Collections.emptyMap(),
                new ByteArrayInputStream(new byte[0])
            );
        }
    }

    public final class ProofBridge {

        @JavascriptInterface
        public void reportProgress(String progress) {
            writeFile("noise-proof-progress.txt", progress);
        }

        @JavascriptInterface
        public void report(String report) {
            writeFile("noise-proof.json", report);
        }

        private void writeFile(String name, String contents) {
            File output = new File(getFilesDir(), name);
            try (FileOutputStream stream = new FileOutputStream(output)) {
                stream.write(contents.getBytes(StandardCharsets.UTF_8));
            } catch (IOException error) {
                throw new IllegalStateException("Unable to write Noise proof report", error);
            }
        }
    }
}
