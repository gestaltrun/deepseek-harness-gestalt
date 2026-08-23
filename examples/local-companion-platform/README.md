# Local companion Platform

English | [中文](README.zh.md)

Loopback two-instance Platform that mounts Account HTTP, keyless Personal Pairing, and Relay WSS behind one TLS origin. Production listen in [`apps/platform`](../../apps/platform/README.md) stays fail-closed and never imports `DevelopmentKeylessPairingHandshakeProvider`.

The TLS front binds `127.0.0.1` and presents the bundled [`two-instance-relay` localhost certificate](../two-instance-relay/fixtures/localhost-cert.pem). `/v1/*` and `/v1/remote-access/relay` alternate across two in-process instances that share memory Account, pairing-authority, and Relay route stores. GitHub authorization in this composition opens `/v1/account/oauth/github/development-complete` on the same origin, completes as `octocat`, and returns the page origin so Desktop and Mobile receive one Platform Account. `LOCAL_COMPANION_PAGE_ORIGIN` reverse-proxies every other path to Mobile Vite so the browsing context origin matches the trusted Platform origin.

```sh
LOCAL_COMPANION_PORT=8443 LOCAL_COMPANION_PAGE_ORIGIN=http://127.0.0.1:5174 \
  node --import tsx/esm examples/local-companion-platform/tests/fixtures/listen-driver.ts
```

Mobile selects `VITE_PLATFORM_ENV=development` with `VITE_PLATFORM_DEVELOPMENT_ORIGIN=https://127.0.0.1:8443`, the matching callback and unused-distinct production pair, `VITE_PERSONAL_PAIRING_KEYLESS=1`, and `VITE_REMOTE_RELAY_WSS_URL=wss://127.0.0.1:8443/v1/remote-access/relay` plus the required Relay bounds. Desktop uses the same identities under `DSH_PLATFORM_*` and `DSH_PERSONAL_PAIRING_KEYLESS=1`. Clients that can present the loopback certificate open the TLS origin. An Android WebView that cannot trust the bundled certificate opens `LOCAL_COMPANION_PAGE_ORIGIN` on `http://127.0.0.1`; Mobile Vite proxies `/v1` to the listen, and the Mobile entry rewrites Account, pairing, authorization, and Relay onto that page origin. Pairing links still use the HTTPS listen origin.

The Loader scenario boots [`cordis.yml`](cordis.yml) and proves same-account login, disabled-by-default Mobile Access, confirmed pairing, and one encrypted Relay round trip. It is not a product cryptographic implementation.

## Known Limitations and Deferred Work

- The listen uses in-memory stores, the unreviewed keyless handshake, and a bundled test certificate. It is not the operated production Platform.
- Native Capacitor project generation, APNs/FCM, and TestFlight or signed APK packaging remain outside this example.
