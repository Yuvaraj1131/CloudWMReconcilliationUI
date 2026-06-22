# Deployment & Backend Wiring

This app is a **standalone SAPUI5** application that runs on the **SAP Build Work Zone /
Fiori launchpad**, served by the **managed approuter** out of the **HTML5 Application
Repository**, and talks to your already-deployed **CAP** app through a **destination**.

## Your environment

| | |
|---|---|
| CF org | `bsx-sysco-sandbox-f20` |
| CF space | `sandbox-f20` |
| CF API endpoint | `https://api.cf.eu10-004.hana.ondemand.com` |
| CAP app | `CloudWMReconciliation-srv` |
| CAP base URL | `https://bsx-sysco-sandbox-f20-sandbox-f20-cloudwmreconciliation-srv.cfapps.eu10-004.hana.ondemand.com` |
| Destination name | `CloudWM-CAP` |

## How the backend is reached

- **BAS preview** — the `fiori-tools-proxy` in [`ui5.yaml`](ui5.yaml) forwards `/odata/*`
  to the `CloudWM-CAP` destination (same-origin, no CORS).
- **Deployed** — the managed approuter applies the routes in [`xs-app.json`](xs-app.json),
  forwarding `/odata/v4/*` to the same `CloudWM-CAP` destination.

The app calls **relative** URLs (`/odata/v4/<service>/<EntitySet>`), so the same code works
in both contexts.

---

## Step 1 — Create the `CloudWM-CAP` destination

BTP cockpit → subaccount → **Connectivity → Destinations → New Destination**:

| Field | Value |
|---|---|
| Name | `CloudWM-CAP` |
| Type | `HTTP` |
| URL | `https://bsx-sysco-sandbox-f20-sandbox-f20-cloudwmreconciliation-srv.cfapps.eu10-004.hana.ondemand.com` |
| Proxy Type | `Internet` |
| Authentication | `NoAuthentication` |

Add these **Additional Properties**:

| Property | Value | Why |
|---|---|---|
| `HTML5.ForwardAuthToken` | `true` | forwards the logged-in user's JWT to CAP |
| `HTML5.DynamicDestination` | `true` | lets the app target the destination at runtime |
| `WebIDEEnabled` | `true` | makes it visible to BAS for preview |

> If CAP rejects the forwarded token, the CAP app must trust the same XSUAA instance as this
> app (the managed approuter uses the subaccount XSUAA). For same-subaccount apps this is the
> default.

## Step 2 — Get the real service paths and fill `CONFIG`

Open the CAP service index to see the exact OData V4 service + entity-set names:

```
<CAP base URL>/
<CAP base URL>/odata/v4/<service>/$metadata
```

Then set the three URLs in the `CONFIG` block of
[`webapp/controller/Main.controller.js`](webapp/controller/Main.controller.js):

```js
ECC.url  = "/odata/v4/<ecc-service>/<EntitySet>"
HANA.url = "/odata/v4/<hana-service>/<EntitySet>"
POST.url = "/odata/v4/<hana-service>/<EntitySet>"   // entity set that accepts creates
```

Also confirm in `$metadata`:
- the date property name (`dateField`, currently `ERDAT`) and whether it is a date
  (`dateQuote:false`) or a string/DATS field (`dateQuote:true`, `dateFormat:"yyyyMMdd"`);
- whether the "post" service is a plain **entity create** (current assumption, `mode:"single"`)
  or a CAP **action** (needs a different body).

## Step 3 — Preview in BAS

```bash
npm install
npm start          # or: BAS → right-click project → Preview Application → "start"
```

Pick a date → ECC + HANA load in parallel → open **Missing Items** → select rows →
**Post Selected to HANA** → rows turn green.

## Step 4 — Add deployment configuration

Let the Fiori tools generate the (managed-approuter) `mta.yaml` — do **not** hand-write it:

> Command Palette (⇧⌘P) → **Fiori: Add Deployment Configuration** → **Cloud Foundry** →
> **managed approuter** → select destination **`CloudWM-CAP`**.

This creates `mta.yaml`, wires `xs-app.json`, and adds build scripts.

## Step 5 — Build & deploy

```bash
npm install -g mbt                 # one-time
cf install-plugin multiapps        # one-time (enables "cf deploy")
cf login -a https://api.cf.eu10-004.hana.ondemand.com   # org bsx-sysco-sandbox-f20 / space sandbox-f20
mbt build                          # -> mta_archives/<app>.mtar
cf deploy mta_archives/*.mtar
```

## Step 6 — Surface it on the launchpad

**SAP Build Work Zone** → your site → add the app to a group/role → assign your user.
The `crossNavigation` inbound in [`webapp/manifest.json`](webapp/manifest.json)
(semantic object `LIPSReconciliation`, action `display`) is what the launchpad uses to
create the tile.
