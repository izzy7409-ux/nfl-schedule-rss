# QSS Streamlabs account connection

Adds Streamlabs OAuth to the existing Quiet Storm Sports controller. Scope is `socket.token` only. Includes free YouTube subscription events, memberships, Super Chats, Super Stickers, and Streamlabs tips.

The existing browser overlay receives events while its automated EVMux URL is open. It checks for changed connection settings every ten seconds, so authorizing or disconnecting does not require replacing the browser source. Existing YouTube Studio sync, controls, topics, and visual layout are retained.

## One-time account setup

The controller displays Streamlabs registration fields, including the exact callback URL. Save the application client ID and secret in the private controller, then select Connect Streamlabs and authorize the account. Unapproved Streamlabs applications require the owner's account in the whitelist. The provider sign-in and approval must be completed by the account owner.

## Credentials

`QSS_STREAMLABS_ENCRYPTION_KEY` is a base64-encoded random 32-byte Vercel Secret. OAuth credentials and short-lived browser-bound state are encrypted with AES-256-GCM in the existing private Blob store at `qss-overlay/streamlabs-oauth.enc.json`. No tokens are returned by the control status endpoint. The existing live overlay receives its socket token through the already protected stream-config endpoint.

`QSS_STREAMLABS_ORIGIN` is the public QSS origin, defaulting to the current alias. `QSS_CONTROL_SECRET` and `BLOB_READ_WRITE_TOKEN` retain their existing values.

## Deployment

This source targets only the QSS alias. Deploy as a preview in the existing project with its preview secrets, verify the build, then move only `quiet-storm-sports-overlay.vercel.app` to the verified deployment. Other project aliases and the separate Railway Ravens tools are unaffected.

The large existing `lib/qss-state.js` file is preserved byte-for-byte using its immutable uploaded file SHA in `deployment-source.json`. The deployment file list includes that reference along with the files in this directory, excluding test files, README, this manifest, and local dependencies. This preserves the current Blob state/configuration implementation instead of rewriting it.

## Validation

Run `npm test`. Tests cover encrypted storage, authorization scope, browser binding, expired/replayed state, denied connections, private controls, origin checks, token redaction, disconnect, free subscriber events, monetary values, and batched event identifiers.
