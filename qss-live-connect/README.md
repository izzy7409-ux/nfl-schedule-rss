# QSS Streamlabs account connection

Adds Streamlabs OAuth to the existing Quiet Storm Sports controller. Scope is `socket.token` only. Includes free YouTube subscription events, memberships, gifted memberships, Super Chats, Super Stickers, and Streamlabs tips.

The existing browser overlay receives events while its automated EVMux URL is open. It checks for changed connection settings every ten seconds, so authorizing or disconnecting does not require replacing the browser source. Existing YouTube Studio sync, controls, topics, and visual layout are retained.

## Existing account connection

An existing Streamlabs Socket Token also provides live events without OAuth registration. The controller reports that saved connection and its live status, keeps OAuth setup optional, and opens the automated overlay from its main Open Overlay link. Keep that automated URL active in EVMux for incoming events. Existing tokens are retained.

## Optional OAuth account setup

The controller displays Streamlabs registration fields, including the exact callback URL. Save the application client ID and secret in the private controller, then select Connect Streamlabs and authorize the account. Unapproved Streamlabs applications require the owner's account in the whitelist. The provider sign-in and approval must be completed by the account owner.

## Credentials

`QSS_STREAMLABS_ENCRYPTION_KEY` is a base64-encoded random 32-byte Vercel Secret. OAuth credentials and short-lived browser-bound state are encrypted with AES-256-GCM in the existing private Blob store at `qss-overlay/streamlabs-oauth.enc.json`. No tokens are returned by the control status endpoint. The existing live overlay receives its socket token through the already protected stream-config endpoint.

`QSS_STREAMLABS_ORIGIN` is the public QSS origin, defaulting to the current alias. `QSS_CONTROL_SECRET` and `BLOB_READ_WRITE_TOKEN` retain their existing values.

## Deployment

This source targets only the QSS alias. Deploy as a preview in the existing project with its preview secrets, verify the build, then move only `quiet-storm-sports-overlay.vercel.app` to the verified deployment. Other project aliases and the separate Railway Ravens tools are unaffected.

The existing `lib/qss-state.js` is included byte-for-byte in source. Its SHA-1 matches the immutable original upload in `deployment-source.json`. Exclude test files, README, this manifest, and local dependencies from the deployment file list. The existing Blob state and configuration implementation is preserved.

## Validation

Run `npm test`. Tests cover encrypted storage, authorization scope, browser binding, expired/replayed state, denied connections, private controls, origin checks, token redaction, disconnect, free subscriber events, monetary values, and batched event identifiers.

## Supporter display

New events received from Streamlabs move to the top of the three-row supporter box. Super Chats display the supplied formatted price or their documented micro-unit amount. YouTube `membershipGift` events display the gift count, such as `5 GIFTS`, and gifted subscription events attribute the giver. Memberships show formatted currency only when Streamlabs supplies it, otherwise their duration or membership status. Gift counts are never converted into an estimated price. Test, preview, and replay alerts are ignored. Event saves are queued so bursts do not overwrite each other.
