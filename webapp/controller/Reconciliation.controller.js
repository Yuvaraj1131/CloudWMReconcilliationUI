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
	//  Maps onto the deployed CAP "ReconcileService" (OData V4). All paths are
	//  relative and reached through the CloudWMReconcilliation destination — the
	//  ui5.yaml proxy (BAS preview) and the xs-app.json route (deployed) both
	//  forward /ReconcileService/* there.
	//
	//  The three services are an OData V4 function pair + one action:
	//    Service 1 (ECC)  : GET  getECCDeliveryItems(CreatedOn=<DateTimeOffset>)
	//    Service 2 (HANA) : GET  getHanaDeliveryItems(DeliveryDate=<Date>)
	//    Service 3 (POST) : POST updateHanaDeliveryItems  body {items:[…]} -> string
	// =====================================================================

	// The ECC function returns raw S/4 field names; the HANA function returns the
	// CAP DeliveryItems property names. Map ECC -> the CAP shape so display,
	// reconciliation AND the write-back all share one canonical structure.
	var ECC_TO_HANA = {
		Delivery: "Delivery_Delivery",
		Item: "Item",
		Material: "Material_Material",
		DeliveryQty: "DeliveryQuantity",
		SalesUnit: "SalesUnit_UnitCode",
		Plant: "Plant",
		StorLocation: "StorageLocation",
		ItemCategory: "ItemCategory",
		Createdby: "CreatedBy",
		Createdon: "CreatedOn",
		Batch: "Batch",
		BaseUnit: "BaseUnitOfMeasure_UnitCode",
		WeightUnit: "WeightUnit_UnitCode",
		VolumeUnit: "VolumeUnit_UnitCode",
		Numerator: "Numerator",
		Denominat: "Denominator",
		NetWeight: "NetWeight",
		GrossWeight: "GrossWeight",
		Volume: "Volume",
		PartDlvitem: "PartdlvItem",
		WarehouseNumber: "WarehouseNumber_WarehouseNumber",
		SplitToWarehouseNo: "SplitToWarehouseNo",
		StorageType: "StorageType",
		StorageBin: "StorageBin",
		MovementType: "MovementType",
		MovementType2: "MovementType2",
		IndDynamicbin: "IndDynamicBin",
		SalesOrder: "SalesOrder_SalesDocument",
		SalesOrdItem: "SalesOrderItem",
		DeleteIndicator: "DeleteIndicator",
		Time: "Time",
		IsPicked: "IsPicked"
	};

	var CONFIG = {

		// Base path of the deployed CAP service (confirmed working). The service
		// is exposed at /ReconcileService — NOT the OData V4 default /odata/v4/…
		SERVICE_BASE: "/ReconcileService",

		// Service 1 — ECC source. Unbound function, date passed as a parameter.
		ECC: {
			type: "function",
			name: "getECCDeliveryItems",
			dateParam: "CreatedOn",
			dateLiteral: "date",  // service accepts a bare yyyy-MM-dd (verified working)
			fieldMap: ECC_TO_HANA // remap raw ECC keys to the canonical CAP shape
		},

		// Service 2 — HANA source. Unbound function, date passed as a parameter.
		HANA: {
			type: "function",
			name: "getHanaDeliveryItems",
			dateParam: "DeliveryDate",
			dateLiteral: "date"             // -> 2026-06-22
		},

		// Service 3 — write the selected missing items into HANA. Unbound action.
		POST: {
			type: "action",
			name: "updateHanaDeliveryItems",
			paramName: "items",             // action parameter holding the array
			useCsrf: true                   // fetch an X-CSRF-Token first (best-effort)
		},

		// Reconciliation key on ReconcileService.DeliveryItems.
		KEY_FIELDS: ["Delivery_Delivery", "Item"],

		// Entity properties shown in the tables / matched by the search field.
		FIELDS: ["Delivery_Delivery", "Item", "Material_Material", "DeliveryQuantity", "SalesUnit_UnitCode", "Plant", "StorageLocation"]
	};

	return Controller.extend("com.bluestonex.cloudwmreconcilliationui.controller.Reconciliation", {

		/* ============================================================= */
		/*  LIFECYCLE                                                    */
		/* ============================================================= */

		onInit: function () {
			// UI state model — drives counts, busy flag, selected tab, footer, etc.
			this.getView().setModel(new JSONModel({
				busy: false,
				dateText: this._today(),
				masterData: "DELIVERY_ITEM",   // which table to reconcile (only this one is live)
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

			// Only the Delivery Item table is wired to services for now.
			if (oUi.getProperty("/masterData") !== "DELIVERY_ITEM") {
				return;
			}

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
		 * Master Data dropdown changed. Only "Delivery Item" is wired to services;
		 * the others show a "coming soon" placeholder, so clear any stale data.
		 */
		onMasterDataChange: function () {
			var oUi = this.getView().getModel("ui");
			if (oUi.getProperty("/masterData") !== "DELIVERY_ITEM") {
				this.getView().getModel("ecc").setProperty("/items", []);
				this.getView().getModel("hana").setProperty("/items", []);
				this.getView().getModel("missing").setProperty("/items", []);
				oUi.setProperty("/eccCount", 0);
				oUi.setProperty("/hanaCount", 0);
				oUi.setProperty("/missingCount", 0);
				oUi.setProperty("/selectedCount", 0);
			}
		},

		/**
		 * Live client-side filter across the visible fields for the active table.
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
		/*  CORE: POSTING (OData V4 action)                              */
		/* ============================================================= */

		/**
		 * Send all selected items to the updateHanaDeliveryItems action in one call.
		 * The action takes the whole collection, so success/failure is all-or-nothing.
		 */
		_doPost: function (aContexts) {
			var oModel = this.getView().getModel("missing");
			var oUi = this.getView().getModel("ui");
			var oTable = this.byId("tblMissing");

			oUi.setProperty("/busy", true);
			oUi.setProperty("/postInFlight", true);

			var aItems = aContexts.map(function (oCtx) {
				return this._cleanRecord(oModel.getProperty(oCtx.getPath()));
			}.bind(this));

			this._callAction(aItems).then(function (sResult) {
				aContexts.forEach(function (oCtx) {
					oModel.setProperty(oCtx.getPath() + "/posted", true);
					oModel.setProperty(oCtx.getPath() + "/postError", "");
				});
				oTable.removeSelections(true);
				this._updateSelectedCount();
				this._refreshMissingCount();
				this._applyMissingRowStyles();
				MessageToast.show(this._t("postAllOk", [aItems.length]) + (sResult ? " — " + sResult : ""));
			}.bind(this)).catch(function (oErr) {
				var sMsg = (oErr && oErr.message) ? oErr.message : String(oErr);
				aContexts.forEach(function (oCtx) {
					oModel.setProperty(oCtx.getPath() + "/posted", false);
					oModel.setProperty(oCtx.getPath() + "/postError", sMsg);
				});
				this._applyMissingRowStyles();
				MessageBox.error(this._t("postError") + "\n\n" + sMsg);
			}.bind(this)).then(function () {
				oUi.setProperty("/busy", false);
				oUi.setProperty("/postInFlight", false);
			});
		},

		/**
		 * Invoke the unbound action, optionally after a CSRF-token handshake.
		 * @returns {Promise<string>} the action's string result (if any).
		 */
		_callAction: function (aItems) {
			var that = this;
			var sUrl = this._serviceBase() + "/" + CONFIG.POST.name;
			var oBody = {};
			oBody[CONFIG.POST.paramName] = aItems;

			var fnPost = function (sToken) {
				return that._ajax(sUrl, "POST", oBody, sToken).then(function (oResp) {
					// An action returning Edm.String comes back as { value: "…" } in V4.
					if (oResp && typeof oResp === "object" && oResp.value !== undefined) {
						return oResp.value;
					}
					return (typeof oResp === "string") ? oResp : "";
				});
			};

			if (CONFIG.POST.useCsrf) {
				return this._csrfToken(this._serviceBase()).then(fnPost);
			}
			return fnPost("");
		},

		/**
		 * Strip local UI flags and OData annotations before sending a record back to CAP.
		 */
		_cleanRecord: function (oRec) {
			var oOut = {};
			Object.keys(oRec || {}).forEach(function (sKey) {
				if (sKey === "posted" || sKey === "postError" || sKey.charAt(0) === "@") {
					return;
				}
				oOut[sKey] = oRec[sKey];
			});
			return oOut;
		},

		/* ============================================================= */
		/*  CORE: RECONCILIATION                                         */
		/* ============================================================= */

		/**
		 * Missing = items present in ECC but absent from HANA, keyed on
		 * Delivery_Delivery + Item.
		 */
		_reconcile: function (aEcc, aHana) {
			var oHanaIndex = {};
			aHana.forEach(function (o) {
				oHanaIndex[this._key(o)] = true;
			}.bind(this));

			var aMissing = aEcc.filter(function (o) {
				return !oHanaIndex[this._key(o)];
			}.bind(this)).map(function (o) {
				// Keep the FULL ECC record so it can be written back to HANA verbatim;
				// only add local status flags.
				var oRow = Object.assign({}, o);
				oRow.posted = false;
				oRow.postError = "";
				return oRow;
			});

			this.getView().getModel("missing").setProperty("/items", aMissing);
			this.getView().getModel("ui").setProperty("/missingCount", aMissing.length);
			this.getView().getModel("ui").setProperty("/selectedCount", 0);
		},

		_key: function (o) {
			return CONFIG.KEY_FIELDS.map(function (sField) {
				return String(o[sField] == null ? "" : o[sField]).trim();
			}).join("");
		},

		/* ============================================================= */
		/*  CORE: SERVICE I/O + RESPONSE NORMALIZATION                   */
		/* ============================================================= */

		/**
		 * Invoke one OData V4 function for a given date and return a normalized array.
		 */
		_fetchService: function (oCfg, sDate) {
			var sUrl = this._buildFunctionUrl(oCfg, sDate);
			return this._ajax(sUrl, "GET").then(function (oData) {
				var aRecords = this._normalize(oData);
				if (oCfg.fieldMap) {
					aRecords = aRecords.map(function (o) {
						return this._mapRecord(o, oCfg.fieldMap);
					}.bind(this));
				}
				return aRecords;
			}.bind(this));
		},

		/**
		 * Build an unbound OData V4 function-call URL with an inline date parameter,
		 * e.g. /ReconcileService/getHanaDeliveryItems(DeliveryDate=2026-06-22)
		 */
		_buildFunctionUrl: function (oCfg, sDate) {
			var sLiteral = this._functionDateLiteral(sDate, oCfg.dateLiteral);
			return this._serviceBase() + "/" + oCfg.name + "(" + oCfg.dateParam + "=" + sLiteral + ")";
		},

		/**
		 * OData V4 temporal literals are unquoted. Edm.Date -> yyyy-MM-dd;
		 * Edm.DateTimeOffset -> yyyy-MM-ddT00:00:00Z (DatePicker yields yyyy-MM-dd).
		 */
		_functionDateLiteral: function (sIso, sKind) {
			if (!sIso) {
				return sIso;
			}
			if (sKind === "datetimeoffset") {
				return sIso + "T00:00:00Z";
			}
			return sIso;
		},

		_serviceBase: function () {
			return CONFIG.SERVICE_BASE.replace(/\/+$/, "");
		},

		/**
		 * Remap a source record's keys via oMap (sourceKey -> canonicalKey) and
		 * convert ECC's OData V2 date ("/Date(ms)/") and ISO-8601 duration
		 * ("PT10H13M57S") into the Edm.Date / Edm.TimeOfDay literals CAP uses.
		 */
		_mapRecord: function (oRaw, oMap) {
			var oOut = {};
			Object.keys(oMap).forEach(function (sFrom) {
				if (oRaw[sFrom] !== undefined) {
					oOut[oMap[sFrom]] = oRaw[sFrom];
				}
			});
			if (typeof oOut.CreatedOn === "string" && oOut.CreatedOn.indexOf("/Date(") === 0) {
				oOut.CreatedOn = this._fromV2Date(oOut.CreatedOn);
			}
			if (typeof oOut.Time === "string" && oOut.Time.indexOf("PT") === 0) {
				oOut.Time = this._fromIsoDuration(oOut.Time);
			}
			return oOut;
		},

		/** "/Date(1780617600000)/" -> "2026-06-05" (UTC). */
		_fromV2Date: function (sVal) {
			var aMatch = /\/Date\((-?\d+)\)\//.exec(sVal);
			if (!aMatch) {
				return sVal;
			}
			var oDate = new Date(parseInt(aMatch[1], 10));
			var pad = function (n) { return String(n).padStart(2, "0"); };
			return oDate.getUTCFullYear() + "-" + pad(oDate.getUTCMonth() + 1) + "-" + pad(oDate.getUTCDate());
		},

		/** "PT10H13M57S" -> "10:13:57". */
		_fromIsoDuration: function (sVal) {
			var aMatch = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(sVal);
			if (!aMatch) {
				return sVal;
			}
			var pad = function (n) { return String(n || 0).padStart(2, "0"); };
			return pad(aMatch[1]) + ":" + pad(aMatch[2]) + ":" + pad(aMatch[3]);
		},

		/**
		 * Normalize any of OData V2, OData V4 or plain REST into a flat array.
		 *   - OData V4 collection : { value: [...] }   (function results land here)
		 *   - OData V2 collection : { d: { results: [...] } }
		 *   - OData V2 entity     : { d: { ... } }
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
		 * Best-effort CSRF token fetch (GET the service document). Resolves to "" on
		 * failure so the action can still proceed when no token is required.
		 */
		_csrfToken: function (sUrl) {
			return new Promise(function (resolve) {
				var oXhr = new XMLHttpRequest();
				oXhr.open("GET", sUrl, true);
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
