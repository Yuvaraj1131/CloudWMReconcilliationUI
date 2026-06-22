# LIPS Reconciliation Monitor

A freestyle **SAPUI5** application that reconciles SAP **LIPS** delivery items between an
**ECC** source and a **HANA** (CAP) target for a chosen date, and lets you post the missing
items back into HANA.

## Features

- Date-picker filter that queries the ECC and HANA services **in parallel**.
- Three tabs (`IconTabBar`): **ECC Data**, **HANA Data**, **Missing Items**.
- Each table shows the LIPS fields: `VBELN, POSNR, MATNR, ARKTX, LFIMG, VRKME, WERKS, LGORT`.
- **Missing Items** = present in ECC but absent from HANA, reconciled on `VBELN` + `POSNR`.
- Multi-select with a **Post Selected to HANA** action; posted rows turn **green**, failures **red**.
- Auto-navigates to the **Missing Items** tab when gaps are detected.
- Response parsing handles **OData V2, OData V4 and plain REST** automatically.
- `sap_horizon` theme.

## Project structure

```
CloudWMReconcilliationUI/
├─ package.json            # UI5 tooling + scripts
├─ ui5.yaml                # local dev server + proxy to the backends
├─ xs-app.json             # approuter routes (BTP / Cloud Foundry)
└─ webapp/
   ├─ index.html           # bootstrap (sap_horizon theme)
   ├─ Component.js
   ├─ manifest.json        # app descriptor
   ├─ controller/Main.controller.js   # all logic + CONFIG block
   ├─ view/Main.view.xml
   ├─ model/models.js
   ├─ i18n/i18n.properties
   └─ css/style.css
```

## Configure your services

The three services are wired through the `CONFIG` block at the top of
[`webapp/controller/Main.controller.js`](webapp/controller/Main.controller.js).

1. **Service paths** — replace `REPLACE_ECC_SERVICE` / `REPLACE_HANA_SERVICE` with your CAP
   service paths + entity sets (e.g. `/odata/v4/lips/LIPSItems`).
2. **Date filter** — the services are CAP (**OData V4**), so the app filters with
   `$filter=ERDAT eq <date>` by default (`dateMode: "odata"`). Adjust per service:
   - `dateField` — the property to filter on.
   - `dateQuote: true` and `dateFormat: "yyyyMMdd"` if your date is a string field (SAP DATS).
   - Switch `dateMode` to `"param"` if a CAP handler instead reads a custom query parameter.
3. **POST** — `mode: "single"` posts one entity per item (correct for OData V4 creates).
   CSRF token handshake is on (`useCsrf: true`), as CAP protects modifying requests by default.

## Wire the backends

- **Local dev:** point the `/ecc` and `/hana` proxy targets in
  [`ui5.yaml`](ui5.yaml) at your CAP service hosts. (If a single CAP app serves both, point
  both at the same host.)
- **BTP / Cloud Foundry:** set the `ecc-backend` / `hana-backend` destinations referenced in
  [`xs-app.json`](xs-app.json).

## Run

```bash
npm install
npm start
```
