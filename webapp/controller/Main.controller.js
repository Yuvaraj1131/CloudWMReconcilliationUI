sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"sap/m/MessageToast",
	"sap/m/MessageBox"
], function (Controller, JSONModel, Filter, FilterOperator, MessageToast, MessageBox) {
	"use strict";

	// =====================================================================
	//  CONFIG
	//  ---------------------------------------------------------------------
	//  Drop your real endpoints in here. The three services were described
	//  as already built; only the URLs need wiring up.
	//
	//  All three are paths on ONE deployed CAP app (OData V4). They are
	//  reached through the CloudWM-CAP destination — the ui5.yaml proxy (BAS
	//  preview) and the xs-app.json route (deployed) both forward /odata/*
	//  there, so these URLs stay relative.
	// =====================================================================
	var CONFIG = {

		// Service 1 — fetch LIPS delivery items from ECC, filtered by date.
		ECC: {
			url: "/odata/v4/REPLACE_ECC_SERVICE/LIPSItems",  // CAP service path + entity set
			method: "GET",
			// CAP services speak OData V4 — filter by date with a $filter system query option.
			//   dateMode "odata" -> $filter=<dateField> <dateOperator> <value>
			//   dateMode "param" -> <dateParam>=<value>   (use this if your CAP handler reads a custom query param)
			dateMode: "odata",
			dateField: "ERDAT",         // OData property to filter on
			dateOperator: "eq",
			dateQuote: false,           // true when the date is modelled as a string (cds.String / SAP DATS) -> 'value'
			dateFormat: "yyyy-MM-dd",   // "yyyy-MM-dd" for cds.Date; "yyyyMMdd" for DATS strings
			dateParam: "date",          // only used when dateMode = "param"
			extraParams: {}             // constant query options, e.g. {"$top": "5000", "$orderby": "VBELN,POSNR"}
		},

		// Service 2 — fetch LIPS delivery items from HANA, filtered by date.
		HANA: {
			url: "/odata/v4/REPLACE_HANA_SERVICE/LIPSItems",  // CAP service path + entity set
			method: "GET",
			dateMode: "odata",
			dateField: "ERDAT",
			dateOperator: "eq",
			dateQuote: false,
			dateFormat: "yyyy-MM-dd",
			dateParam: "date",
			extraParams: {}
		},

		// Service 3 — POST missing items into HANA.
		POST: {
			url: "/odata/v4/REPLACE_HANA_SERVICE/LIPSItems",  // CAP entity set that accepts creates
			method: "POST",
			// "single"  -> one POST per item (correct for CAP / OData V4 entity-set creates)
			// "batch"   -> one POST with an array body (only if your CAP service exposes a custom bulk action)
			mode: "single",
			// For "batch" mode the array is wrapped under this key. Use "" to POST the bare array.
			batchWrapperKey: "items",
			// CAP enforces CSRF protection on modifying requests by default — fetch a token first.
			useCsrf: true
		},

		// LIPS fields surfaced by the app. The first two form the reconciliation key.
		FIELDS: ["VBELN", "POSNR", "MATNR", "ARKTX", "LFIMG", "VRKME", "WERKS", "LGORT"],
		KEY_FIELDS: ["VBELN", "POSNR"]
	};

	return Controller.extend("com.bluestonex.cloudwmreconcilliationui.controller.Main", {

		/* ============================================================= */
		/*  LIFECYCLE                                                    */
		/* ============================================================= */

		onInit: function () {
			// UI state model — drives counts, busy flag, selected tab, footer, etc.
			this.getView().setModel(new JSONModel({
				busy: false,
				dateText: this._today(),
				selectedTab: "ECC",
				eccCount: 0,
				hanaCount: 0,
				missingCount: 0,
				selectedCount: 0,
				lastRefreshed: "-",
				postInFlight: false
			}), "ui");

			// One JSON model per dataset.
			this.getView().setModel(new JSONModel({ items: [] }), "ecc");
			this.getView().setModel(new JSONModel({ items: [] }), "hana");
			this.getView().setModel(new JSONModel({ items: [] }), "missing");
		},

		/* ============================================================= */
		/*  EVENT HANDLERS                                               */
		/* ============================================================= */

		onDateChange: function (oEvent) {
			if (!oEvent.getParameter("valid")) {
				MessageToast.show(this._t("invalidDate"));
				return;
			}
			// Auto-load whenever the user picks a valid date.
			this.onLoad();
		},

		/**
		 * Fire Service 1 (ECC) and Service 2 (HANA) in parallel, then reconcile.
		 */
		onLoad: function () {
			var oUi = this.getView().getModel("ui");
			var sDate = oUi.getProperty("/dateText");

			if (!sDate) {
				MessageToast.show(this._t("pickDateFirst"));
				return;
			}

			oUi.setProperty("/busy", true);

			Promise.all([
				this._fetchService(CONFIG.ECC, sDate),
				this._fetchService(CONFIG.HANA, sDate)
			]).then(function (aResults) {
				var aEcc = aResults[0];
				var aHana = aResults[1];

				this.getView().getModel("ecc").setProperty("/items", aEcc);
				this.getView().getModel("hana").setProperty("/items", aHana);

				this._reconcile(aEcc, aHana);

				oUi.setProperty("/eccCount", aEcc.length);
				oUi.setProperty("/hanaCount", aHana.length);
				oUi.setProperty("/lastRefreshed", this._now());
				oUi.setProperty("/busy", false);

				var iMissing = this.getView().getModel("missing").getProperty("/items").length;
				MessageToast.show(this._t("loadDone", [aEcc.length, aHana.length, iMissing]));

				// Auto-navigate to the Missing Items tab when gaps are detected.
				if (iMissing > 0) {
					oUi.setProperty("/selectedTab", "MISSING");
				}
			}.bind(this)).catch(function (oErr) {
				oUi.setProperty("/busy", false);
				MessageBox.error(this._t("loadError") + "\n\n" + (oErr && oErr.message ? oErr.message : oErr));
			}.bind(this));
		},

		onTabSelect: function (oEvent) {
			this.getView().getModel("ui").setProperty("/selectedTab", oEvent.getParameter("key"));
		},

		/**
		 * Live client-side filter across the visible LIPS fields for the active table.
		 */
		onSearch: function (oEvent) {
			var sQuery = (oEvent.getParameter("query") || oEvent.getParameter("newValue") || "").trim();
			var oTable = oEvent.getSource();
			// Walk up to the owning table (SearchField sits in the header toolbar).
			while (oTable && !oTable.isA("sap.m.Table")) {
				oTable = oTable.getParent();
			}
			if (!oTable) {
				return;
			}

			var oBinding = oTable.getBinding("items");
			if (!oBinding) {
				return;
			}

			if (!sQuery) {
				oBinding.filter([]);
				return;
			}

			var aFieldFilters = CONFIG.FIELDS.map(function (sField) {
				return new Filter(sField, FilterOperator.Contains, sQuery);
			});
			oBinding.filter(new Filter({ filters: aFieldFilters, and: false }));
		},

		onMissingSelectionChange: function () {
			this._updateSelectedCount();
		},

		/**
		 * Re-apply the posted/failed row tint whenever the Missing table re-renders
		 * (initial load, growing, filtering). Keeps the green/red wash in sync with
		 * the model — the "highlight" property alone only paints the left accent bar.
		 */
		onMissingTableUpdate: function () {
			this._applyMissingRowStyles();
		},

		onSelectAllPending: function () {
			var oTable = this.byId("tblMissing");
			var aItems = oTable.getItems();
			var oModel = this.getView().getModel("missing");

			aItems.forEach(function (oItem) {
				var oCtx = oItem.getBindingContext("missing");
				// Only (re)select rows that have not yet been posted successfully.
				if (oCtx && !oModel.getProperty(oCtx.getPath() + "/posted")) {
					oTable.setSelectedItem(oItem, true);
				}
			});
			this._updateSelectedCount();
		},

		/**
		 * POST every selected, not-yet-posted item via Service 3. Rows flip green on success.
		 */
		onPostSelected: function () {
			var oTable = this.byId("tblMissing");
			var oModel = this.getView().getModel("missing");
			var oUi = this.getView().getModel("ui");

			var aContexts = oTable.getSelectedContexts().filter(function (oCtx) {
				return !oModel.getProperty(oCtx.getPath() + "/posted");
			});

			if (!aContexts.length) {
				MessageToast.show(this._t("nothingToPost"));
				return;
			}

			MessageBox.confirm(this._t("confirmPost", [aContexts.length]), {
				onClose: function (sAction) {
					if (sAction === MessageBox.Action.OK) {
						this._doPost(aContexts);
					}
				}.bind(this)
			});
		},

		/* ============================================================= */
		/*  CORE: POSTING                                                */
		/* ============================================================= */

		_doPost: function (aContexts) {
			var oModel = this.getView().getModel("missing");
			var oUi = this.getView().getModel("ui");
			var oTable = this.byId("tblMissing");

			oUi.setProperty("/busy", true);
			oUi.setProperty("/postInFlight", true);

			var aPayloads = aContexts.map(function (oCtx) {
				return { path: oCtx.getPath(), data: this._pickFields(oModel.getProperty(oCtx.getPath())) };
			}.bind(this));

			this._postPayloads(aPayloads, oModel).then(function (oSummary) {
				oUi.setProperty("/busy", false);
				oUi.setProperty("/postInFlight", false);

				// Deselect the rows we just successfully posted.
				oTable.removeSelections(true);
				this._updateSelectedCount();
				this._refreshMissingCount();
				this._applyMissingRowStyles();

				if (oSummary.failed === 0) {
					MessageToast.show(this._t("postAllOk", [oSummary.ok]));
				} else {
					MessageBox.warning(this._t("postPartial", [oSummary.ok, oSummary.failed]));
				}
			}.bind(this)).catch(function (oErr) {
				oUi.setProperty("/busy", false);
				oUi.setProperty("/postInFlight", false);
				MessageBox.error(this._t("postError") + "\n\n" + (oErr && oErr.message ? oErr.message : oErr));
			}.bind(this));
		},

		/**
		 * Dispatch payloads according to CONFIG.POST.mode and tag each row's result.
		 * @returns {Promise<{ok:number, failed:number}>}
		 */
		_postPayloads: function (aPayloads, oModel) {
			var that = this;

			return this._csrfToken(CONFIG.POST).then(function (sToken) {

				function tag(sPath, bOk, oRespOrErr) {
					oModel.setProperty(sPath + "/posted", bOk);
					oModel.setProperty(sPath + "/postError", bOk ? "" : (oRespOrErr && oRespOrErr.message ? oRespOrErr.message : String(oRespOrErr || "failed")));
				}

				if (CONFIG.POST.mode === "batch") {
					var oBody = CONFIG.POST.batchWrapperKey
						? (function () { var o = {}; o[CONFIG.POST.batchWrapperKey] = aPayloads.map(function (p) { return p.data; }); return o; })()
						: aPayloads.map(function (p) { return p.data; });

					return that._ajax(CONFIG.POST.url, "POST", oBody, sToken).then(function () {
						aPayloads.forEach(function (p) { tag(p.path, true); });
						return { ok: aPayloads.length, failed: 0 };
					}).catch(function (oErr) {
						aPayloads.forEach(function (p) { tag(p.path, false, oErr); });
						throw oErr;
					});
				}

				// "single" mode — one request per row; failures are isolated per row.
				var iOk = 0, iFailed = 0;
				return aPayloads.reduce(function (oChain, p) {
					return oChain.then(function () {
						return that._ajax(CONFIG.POST.url, "POST", p.data, sToken).then(function () {
							tag(p.path, true);
							iOk++;
						}).catch(function (oErr) {
							tag(p.path, false, oErr);
							iFailed++;
						});
					});
				}, Promise.resolve()).then(function () {
					return { ok: iOk, failed: iFailed };
				});
			});
		},

		/* ============================================================= */
		/*  CORE: RECONCILIATION                                         */
		/* ============================================================= */

		/**
		 * Missing = items present in ECC but absent from HANA, keyed on VBELN + POSNR.
		 */
		_reconcile: function (aEcc, aHana) {
			var oHanaIndex = {};
			aHana.forEach(function (o) {
				oHanaIndex[this._key(o)] = true;
			}.bind(this));

			var aMissing = aEcc.filter(function (o) {
				return !oHanaIndex[this._key(o)];
			}.bind(this)).map(function (o) {
				// Clone + reset post-status flags so re-loads start clean.
				var oRow = this._pickFields(o);
				oRow.posted = false;
				oRow.postError = "";
				return oRow;
			}.bind(this));

			this.getView().getModel("missing").setProperty("/items", aMissing);
			this.getView().getModel("ui").setProperty("/missingCount", aMissing.length);
			this.getView().getModel("ui").setProperty("/selectedCount", 0);
		},

		_key: function (o) {
			return CONFIG.KEY_FIELDS.map(function (sField) {
				return String(o[sField] == null ? "" : o[sField]).trim();
			}).join("");
		},

		/**
		 * Project an arbitrary source record down to the known LIPS fields,
		 * tolerating lower-case / mixed-case field names from REST sources.
		 */
		_pickFields: function (oSrc) {
			var oOut = {};
			CONFIG.FIELDS.forEach(function (sField) {
				oOut[sField] = this._readField(oSrc, sField);
			}.bind(this));
			return oOut;
		},

		_readField: function (oSrc, sField) {
			if (oSrc == null) {
				return "";
			}
			if (oSrc[sField] != null) {
				return oSrc[sField];
			}
			// Case-insensitive fallback (e.g. "vbeln", "Vbeln").
			var sLower = sField.toLowerCase();
			var aKeys = Object.keys(oSrc);
			for (var i = 0; i < aKeys.length; i++) {
				if (aKeys[i].toLowerCase() === sLower) {
					return oSrc[aKeys[i]];
				}
			}
			return "";
		},

		/* ============================================================= */
		/*  CORE: SERVICE I/O + RESPONSE NORMALIZATION                   */
		/* ============================================================= */

		/**
		 * Fetch one source service for a given date and return a normalized array.
		 */
		_fetchService: function (oCfg, sDate) {
			var sUrl = this._buildUrl(oCfg, sDate);
			return this._ajax(sUrl, oCfg.method || "GET").then(function (oData) {
				return this._normalize(oData);
			}.bind(this));
		},

		_buildUrl: function (oCfg, sDate) {
			var aParams = [];
			var sVal = this._formatDate(sDate, oCfg.dateFormat);

			if ((oCfg.dateMode || "odata") === "odata" && oCfg.dateField) {
				// CAP / OData V4 system query option, e.g. $filter=ERDAT eq 2026-06-22
				var sLiteral = oCfg.dateQuote ? ("'" + sVal + "'") : sVal;
				aParams.push("$filter=" + encodeURIComponent(oCfg.dateField + " " + (oCfg.dateOperator || "eq") + " " + sLiteral));
			} else if (oCfg.dateParam) {
				// Custom query parameter, e.g. ?date=2026-06-22
				aParams.push(encodeURIComponent(oCfg.dateParam) + "=" + encodeURIComponent(sVal));
			}

			Object.keys(oCfg.extraParams || {}).forEach(function (sKey) {
				// Leave OData system options ($top, $orderby, ...) unescaped so the server recognises them.
				var sK = sKey.charAt(0) === "$" ? sKey : encodeURIComponent(sKey);
				aParams.push(sK + "=" + encodeURIComponent(oCfg.extraParams[sKey]));
			});

			if (!aParams.length) {
				return oCfg.url;
			}
			return oCfg.url + (oCfg.url.indexOf("?") === -1 ? "?" : "&") + aParams.join("&");
		},

		/**
		 * Reformat the DatePicker value (always "yyyy-MM-dd") to the wire format the
		 * service expects. "yyyyMMdd" suits SAP DATS string fields; the default keeps
		 * the ISO form used by OData V4 Edm.Date.
		 */
		_formatDate: function (sIso, sFormat) {
			if (!sIso) {
				return sIso;
			}
			if (sFormat === "yyyyMMdd") {
				return sIso.replace(/-/g, "");
			}
			return sIso;
		},

		/**
		 * Normalize any of OData V2, OData V4 or plain REST into a flat array.
		 *   - OData V2 collection : { d: { results: [...] } }
		 *   - OData V2 entity     : { d: { ... } }
		 *   - OData V4 collection : { value: [...] }
		 *   - plain REST array    : [ ... ]
		 *   - plain REST wrapped  : { items|records|data|results: [...] }
		 *   - single object       : { ... }
		 */
		_normalize: function (oData) {
			if (oData == null) {
				return [];
			}
			if (Array.isArray(oData)) {
				return oData;                                   // plain REST array
			}
			if (Array.isArray(oData.value)) {
				return oData.value;                             // OData V4 collection
			}
			if (oData.d !== undefined && oData.d !== null) {    // OData V2
				if (Array.isArray(oData.d.results)) {
					return oData.d.results;
				}
				if (Array.isArray(oData.d)) {
					return oData.d;
				}
				return [oData.d];                               // single V2 entity
			}
			// Common plain-REST wrappers.
			var aWrappers = ["results", "items", "records", "data", "value"];
			for (var i = 0; i < aWrappers.length; i++) {
				if (Array.isArray(oData[aWrappers[i]])) {
					return oData[aWrappers[i]];
				}
			}
			// Fall back to treating the payload as a single record.
			return [oData];
		},

		/**
		 * Thin promise-based AJAX wrapper. Sends/accepts JSON and surfaces a
		 * useful error message on non-2xx responses.
		 */
		_ajax: function (sUrl, sMethod, oBody, sCsrfToken) {
			return new Promise(function (resolve, reject) {
				var oXhr = new XMLHttpRequest();
				oXhr.open(sMethod || "GET", sUrl, true);
				oXhr.setRequestHeader("Accept", "application/json");
				if (oBody !== undefined && oBody !== null) {
					oXhr.setRequestHeader("Content-Type", "application/json");
				}
				if (sCsrfToken) {
					oXhr.setRequestHeader("X-CSRF-Token", sCsrfToken);
				}
				oXhr.onload = function () {
					if (oXhr.status >= 200 && oXhr.status < 300) {
						var oParsed = null;
						if (oXhr.responseText) {
							try {
								oParsed = JSON.parse(oXhr.responseText);
							} catch (e) {
								oParsed = oXhr.responseText; // non-JSON 2xx (e.g. 204 / plain text)
							}
						}
						resolve(oParsed);
					} else {
						reject(new Error("HTTP " + oXhr.status + " " + oXhr.statusText + (oXhr.responseText ? " — " + oXhr.responseText.slice(0, 500) : "")));
					}
				};
				oXhr.onerror = function () {
					reject(new Error("Network error calling " + sUrl));
				};
				oXhr.send(oBody !== undefined && oBody !== null ? JSON.stringify(oBody) : null);
			});
		},

		/**
		 * Best-effort CSRF token fetch for the POST service. Resolves to "" when
		 * disabled or unavailable so the POST can still proceed for plain REST.
		 */
		_csrfToken: function (oCfg) {
			if (!oCfg.useCsrf) {
				return Promise.resolve("");
			}
			return new Promise(function (resolve) {
				var oXhr = new XMLHttpRequest();
				oXhr.open("GET", oCfg.url, true);
				oXhr.setRequestHeader("X-CSRF-Token", "Fetch");
				oXhr.setRequestHeader("Accept", "application/json");
				oXhr.onload = function () {
					resolve(oXhr.getResponseHeader("X-CSRF-Token") || "");
				};
				oXhr.onerror = function () {
					resolve(""); // token handshake is best-effort
				};
				oXhr.send(null);
			});
		},

		/* ============================================================= */
		/*  HELPERS                                                      */
		/* ============================================================= */

		_updateSelectedCount: function () {
			var iCount = this.byId("tblMissing").getSelectedContexts().length;
			this.getView().getModel("ui").setProperty("/selectedCount", iCount);
		},

		_refreshMissingCount: function () {
			// "Missing" count reflects rows still outstanding (not yet posted).
			var aItems = this.getView().getModel("missing").getProperty("/items") || [];
			var iOutstanding = aItems.filter(function (o) { return !o.posted; }).length;
			this.getView().getModel("ui").setProperty("/missingCount", iOutstanding);
		},

		/**
		 * Tint each Missing-table row according to its post status:
		 *   posted -> green (.lipsPostedRow), failed -> red (.lipsFailedRow).
		 * Applied to the live ColumnListItem controls so the whole row colours,
		 * complementing the left "highlight" accent driven from the model.
		 */
		_applyMissingRowStyles: function () {
			var oTable = this.byId("tblMissing");
			if (!oTable) {
				return;
			}
			var oModel = this.getView().getModel("missing");
			oTable.getItems().forEach(function (oItem) {
				var oCtx = oItem.getBindingContext("missing");
				if (!oCtx) {
					return;
				}
				var bPosted = !!oModel.getProperty(oCtx.getPath() + "/posted");
				var bFailed = !bPosted && !!oModel.getProperty(oCtx.getPath() + "/postError");
				oItem.toggleStyleClass("lipsPostedRow", bPosted);
				oItem.toggleStyleClass("lipsFailedRow", bFailed);
			});
		},

		_t: function (sKey, aArgs) {
			return this.getView().getModel("i18n").getResourceBundle().getText(sKey, aArgs);
		},

		_today: function () {
			return this._fmt(new Date());
		},

		_fmt: function (oDate) {
			var sMonth = String(oDate.getMonth() + 1).padStart(2, "0");
			var sDay = String(oDate.getDate()).padStart(2, "0");
			return oDate.getFullYear() + "-" + sMonth + "-" + sDay;
		},

		_now: function () {
			var oDate = new Date();
			var pad = function (n) { return String(n).padStart(2, "0"); };
			return this._fmt(oDate) + " " + pad(oDate.getHours()) + ":" + pad(oDate.getMinutes()) + ":" + pad(oDate.getSeconds());
		}
	});
});
