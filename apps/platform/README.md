# `@deepseek-ai/dsh-platform`

English | [中文](README.zh.md)

Platform listen process packaged as a container. GitHub Actions builds the image for pull requests that touch the Platform tree and for matching master pushes. Publishing to GHCR requires an explicit Platform Image dispatch with **push**. ECS pulls a published tag. Secrets come from GitHub Environment `production` at deploy time and are never stored in image layers.

The operated listen process and product clients accept one production identity. `PLATFORM_ORIGIN`, the fixed callback, GitHub client id and credential reference, PostgreSQL database identity, identity namespace, Redis ACL identity, and Relay Redis key prefix are mandatory; there is no development, staging, or default identity.

`GET /` serves the DeepSeek Gestalt product homepage. `GET /healthz` and `GET /readyz` answer `{ ok: true }` after required deployment secrets are present. Missing or inconsistent identity, TLS, `PORT`, or `PLATFORM_LISTEN_HOST` configuration fails before a PostgreSQL or Redis connection; the listen host is either `0.0.0.0` or `127.0.0.1`. The executable calls `launchOperatedPlatform`, which owns validation, transactional PostgreSQL and Redis acquisition, migrations, GitHub OAuth, Account HTTP, health routes, and quiescent teardown. Each Redis owner keeps an error listener while active, destroys a client whose connect fails, and removes the listener after failure or close. Concurrent `SIGINT` and `SIGTERM` requests share one shutdown; the process exits only after HTTP and durable-store owners close, while a close failure is reported and produces a nonzero exit. `OperatedRemoteAccessResources` constructs the PostgreSQL Personal Pairing authority and Relay route stores with the Redis Relay coordinator before listen. Pairing HTTP and Relay WSS stay unmounted until a reviewed Noise handshake is approved.

```sh
docker build -f apps/platform/Dockerfile -t dsh-platform .
```

Publish: Actions → Platform Image → Run workflow → set **push**. Deploy: Actions → Platform Deploy; the workflow validates Environment `production` names first, and applies the image on both ECS hosts only when **deploy** is set. ECS publishes host port 80 to the container listen port 8080 so ALB HTTPS:443 can forward to VPC:80. The apply step uses Docker `json-file` rotation (`20m` × `3` files) so container stdout/stderr cannot fill the host disk. It also runs LoongCollector (`dsh-loongcollector`) so `dsh-platform` stdout/stderr can reach SLS project `gestalt` logstore `application` in `cn-hangzhou`. The collector registers with user-defined machine-group id `gestalt-platform` and reads the Aliyun account id from hardened ECS metadata, falling back to `PLATFORM_SLS_ACCOUNT_ID`. Bind that group to the logstore's Docker stdout Logtail config. ECS SSH and runtime secrets live in Environment `production`.

## Known Limitations and Deferred Work

- Pairing HTTP and Remote Relay WSS are not mounted in this image.
- Redis and PostgreSQL certificate verification cannot be disabled by product configuration. The product-entry test drives `launchOperatedPlatform` with disposable non-TLS store adapters after validating the operated TLS configuration; it is not live operated acceptance.
