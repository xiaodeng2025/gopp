# GOPP TypeScript Publisher

`src/client.ts` exposes verify, channels and content upsert with schema validation, HTTPS/TLS, DNS/SSRF and redirect protections. It is independent of Receiver storage and CMS internals. Use `GoppClient` with a runtime-injected Bearer credential.
