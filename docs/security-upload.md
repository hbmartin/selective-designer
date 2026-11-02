# Upload Security: Design Images

## Summary

Selective Designer stores clients' architectural images, mood-board photos and
model outputs. All of them are **private**. Browsers upload straight to
S3-compatible storage (Cloudflare R2 in production, MinIO locally) with a
[better-upload](https://github.com/Nic13Gamer/better-upload) presigned `PUT`.
The app and the model providers read images back through **short-lived signed
`GET` URLs**. No object is served from a public bucket URL.

Status: the book-cover demo flow this document used to describe has been removed.
The controls below are the target for the generalised upload flow, which lands
in phases P1 (kernel storage and upload intents) and P2 (design uploads) of
[the implementation plan](product/implementation-plan.md). Update this document
as each control is implemented.

## Controls

1. **Authenticated owner only.** A presigned upload URL is issued only to a
   signed-in user who has the `design` permission and owns the target design.
   Server-function and HTTP handlers enforce this themselves and do not rely on
   route guards.
2. **MIME allowlist, checked twice.** Each upload purpose (base image, working
   copy, item photo, cut-out, mask, source photo) has its own allowlist and size
   limit in a kernel upload policy. better-upload refuses to presign any other
   type, and the key builder rejects it again.
3. **Content-Type pinned to the validated MIME.** The signed `PUT` carries the
   allowlisted type, so the browser can't store an object as `text/html`.
4. **Server-generated object keys.** Keys are `<purpose>/<generatedId>.<ext>`.
   The client filename is never used in a key.
5. **Upload intents in the database.** When a presign is issued, the key is
   bound to the requesting user, the upload purpose and an expiry in an
   `upload_intent` table. Registering the upload consumes the intent exactly
   once. This replaces the old in-memory binding, which did not work across
   serverless instances.
6. **Private reads.** Images are read through signed `GET` URLs with a short
   lifetime. Expiry times are rounded so that URLs stay stable inside the Query
   cache. Downloads use `Content-Disposition: attachment`. Model providers get
   their own short-lived signed URLs for the inputs of a single request.
7. **Provider outputs copied immediately.** A workflow step copies each model
   output into owned storage as soon as it is ready. Provider URLs are never
   stored as the source of truth.
8. **CORS limited to the app origin**, so Konva canvases can read pixels
   without being tainted while other origins can't use the bucket.

## Residual risk

The server does not inspect uploaded bytes. A signed-in user could upload a
non-image payload labelled with an allowlisted image MIME. The impact is
limited because the bucket is private, the content type is pinned, and objects
are served from a different origin from the app with `nosniff`.

## Required bucket configuration

- Block all public access, and don't attach a public `r2.dev` URL in
  production.
- Serve objects with `X-Content-Type-Options: nosniff`, and never as an HTML
  content type.
- Allow CORS `GET` and `PUT` only from the app origin(s).
