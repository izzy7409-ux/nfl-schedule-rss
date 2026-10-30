# Quiet Storm Sports on Railway

QSS runs as one persistent Node.js service on Railway. It receives Streamlabs events on the server and pushes state to the overlay and controller through server-sent events. An overlay tab is not required to collect events.

## Run

Use Node.js 22 or newer. Run `npm ci`, then `npm start`. The service listens on `PORT`, defaulting to 3000. `/health` is the Railway health check. The public overlay is `/qss-overlay`. The private controller is `/qss-control?key=<control key>`.

## Persistent data

Mount a Railway volume at `/data` and set `QSS_DATA_DIR=/data`. The service writes state and encrypted connection settings beneath `/data/qss-overlay`. Writes use private file permissions and atomic renames. State mutations are serialized, so overlapping support events and subscriber syncs preserve each other's changes.

Required private settings are `QSS_CONTROL_SECRET` and `QSS_STREAMLABS_ENCRYPTION_KEY`, a base64-encoded 32-byte random key. Set `QSS_STREAMLABS_ORIGIN` to the Railway HTTPS origin. `QSS_BRIDGE_SECRET` protects the optional Studio/recent-event bridge. The Streamlabs socket and YouTube API credentials stay encrypted on the volume and are not returned to the browser.

For a one-time migration, `QSS_INITIAL_STATE_JSON`, `QSS_INITIAL_CONFIG_JSON`, and optional `QSS_INITIAL_OAUTH_JSON` seed missing files only. Existing volume data always wins on subsequent deploys. Preserve the original control key when importing its encrypted configuration. Migration values must be private service variables and must never be checked into Git.

## Streamlabs

The background listener reconnects when connection settings change. YouTube free subscribers display `NEW SUB` and `SUB`. Super Chats and Super Stickers display their supplied currency amounts. Membership gifts display the giver and gift count. Formatted membership prices appear only when supplied by Streamlabs, otherwise membership duration/status is shown. Test, preview, and replay alerts are ignored. The newest three received support events appear at the top of the overlay.

Socket access can use an existing Streamlabs Socket Token. OAuth is optional, uses only `socket.token`, and stores account credentials encrypted. Register new OAuth applications with the Railway website and callback URL shown in the controller.

## Deployment

Repository branch: `qss-railway`. Railway root directory: `/qss-live-connect`. Start command: `npm start`. Mount: `/data`. Use one replica for the local durable data store. Disable service sleep so the event listener stays connected.

The Railway app has no dependency on Vercel functions, storage, or credentials. Previous hosting source remains in Git history for migration reference.

## Validation

Run `npm test`. The suite covers credential encryption, OAuth permissions and browser binding, private control access, gift counts and currency, deduplication, event bursts, server event reception, migration, restart persistence, and live push delivery.
