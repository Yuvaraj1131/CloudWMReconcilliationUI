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

	// ECC -> HANA field map for delivery HEADERS (ZWM_RECONCILE_SRV/DeliveriesSet).
	// ECC casing differs from HANA in a few spots (DeliveryType/ShippingPoint/
	// TotalWeight, and the ECC "Salesorg"/"Salesorganizatoion2" spellings); managed
	// associations use the <assoc>_<key> FK column (…_UnitCode / …_WarehouseNumber).
	// Omitted: SequenceinRoute (ECC String vs HANA Integer) and ECC-only sync fields
	// (IsInitial / FromDateTime) that have no HANA counterpart.
	var ECC_DELIV_TO_HANA = {
		Delivery: "Delivery",
		DeliveryType: "Deliverytype",
		Createdby: "Createdby",
		Createdon: "Createdon",
		Time: "Time",
		DeliveryDate: "DeliveryDate",
		Plandgdsmvmntdate: "Plandgdsmvmntdate",
		Route: "Route",
		Route2: "Route2",
		Salesdistrict: "Salesdistrict",
		ShippingPoint: "Shippingpoint",
		Salesorg: "Salesorganization",
		Salesorganizatoion2: "Salesorganization2",
		Completedelivery: "Completedelivery",
		Billingblock: "Billingblock",
		Deliveryblock: "Deliveryblock",
		Sddocumentcateg: "Sddocumentcateg",
		Shippingconditions: "Shippingconditions",
		ShipToparty: "ShipToparty",
		SoldToparty: "SoldToparty",
		TotalWeight: "Totalweight",
		Netweight: "Netweight",
		Weightunit: "Weightunit_UnitCode",
		Volume: "Volume",
		Volumeunit: "Volumeunit_UnitCode",
		Numberofpackages: "Numberofpackages",
		Warehousenumber: "Warehousenumber_WarehouseNumber",
		IDdeliverySplit: "IdDeliverysplit",
		DistribChannel: "DistribChannel",
		ExternalDeliveryid: "ExternalDeliveryid",
		Order: "Order",
		SearchProcedure: "SearchProcedure",
		CorrDelivery: "CorrectionDelivery",
		Procedure: "Procedure",
		DocCondition: "DocConditionNo",
		Netvalue: "Netvalue",
		RouteSchedule: "RouteSchedule",
		Receivingplant: "ReceivingPlant",
		FinancialDocNo: "FinancialDocNo",
		PaymtGuarantProc: "PaymtGuarantProc",
		PickingTime: "PickingTime",
		TranspPlanTime: "TranspPlanTime",
		LoadingTime: "LoadingTime",
		GoodsissueTime: "GoodsissueTime",
		GoodsIssueTime2: "GoodsIssueTime2",
		DoorforWhseNo: "DoorforWhseNo",
		ShipmentInformationStatus: "ShipmentInformationStatus",
		RetrunsasnCancelled: "ReturnsasnCancelled",
		TimeZone: "TimeZone",
		StatusDecentWhse: "StatusDecentWhse",
		ScenarioLogisticExecution: "ScenarioLogisticExecution",
		OrigSysType: "OriginalSystemType",
		ChangerSysType: "LastChangerSystemType",
		Georoute: "GeographicalRoute",
		Georouteind: "ChgIndforRoute",
		IsMonoCustomer: "IsMonoCustomer",
		DeleteIndicator: "DeleteIndicator"
	};

	var CONFIG = {

		// Base path of the CAP service, resolved RELATIVE to the app's runtime
		// mount. An absolute "/ReconcileServices" works in the BAS dev proxy but
		// 404s once deployed under the Work Zone approuter (it hits the launchpad
		// host root instead of the app's namespaced xs-app.json route). toUrl()
		// yields "./…" locally and the namespaced path when deployed.
		SERVICE_BASE: sap.ui.require.toUrl("com/bluestonex/cloudwmreconcilliationui") + "/ReconcileServices",

		// Per master-data type: ECC/HANA/POST services, reconcile key, display
		// fields, and (item only) the client-side plant filter field.
		TYPES: {
			DELIVERY_ITEM: {
				ECC:  { name: "getECCDeliveryItems",  dateParam: "CreatedOn",    fieldMap: ECC_TO_HANA },
				HANA: { name: "getHanaDeliveryItems", dateParam: "DeliveryDate" },
				POST: { name: "updateHanaDeliveryItems", paramName: "items", useCsrf: true },
				KEY_FIELDS: ["Delivery_Delivery", "Item"],
				FIELDS: ["Delivery_Delivery", "Item", "Material_Material", "DeliveryQuantity", "SalesUnit_UnitCode", "Plant", "StorageLocation"],
				plantField: "Plant"
			},
			DELIVERY_HEADER: {
				ECC:  { name: "getECCDeliveries",  dateParam: "CreatedOn",    fieldMap: ECC_DELIV_TO_HANA },
				HANA: { name: "getHanaDeliveries", dateParam: "DeliveryDate" },
				POST: { name: "updateHanaDeliveries", paramName: "items", useCsrf: true },
				KEY_FIELDS: ["Delivery"],
				FIELDS: ["Delivery", "Deliverytype", "Route", "ShipToparty", "SoldToparty", "DeliveryDate", "Createdby"],
				plantField: "ReceivingPlant"
			}
		}
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
				plant: "BR10",                 // selected plant filter (client-side)
				plants: [                      // dropdown options (rebuilt from data on load)
					{ key: "", text: "All plants" },
					{ key: "BR10", text: "BR10" }
				],
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
		// Active master-data type's config (services, key, fields, plant field);
		// undefined for the not-yet-wired sales types.
		_cfg: function () {
			return CONFIG.TYPES[this.getView().getModel("ui").getProperty("/masterData")];
		},

		onLoad: function () {
			var oUi = this.getView().getModel("ui");
			var sDate = oUi.getProperty("/dateText");
			var oCfg = this._cfg();

			// Live types have a service config (Delivery Item, Delivery Header);
			// the sales types show a "coming soon" placeholder.
			if (!oCfg) {
				return;
			}

			if (!sDate) {
				MessageToast.show(this._t("pickDateFirst"));
				return;
			}

			oUi.setProperty("/busy", true);

			// allSettled: one source failing (e.g. ECC DeliveriesSet not yet
			// exposed) still shows the other side instead of blanking the screen.
			Promise.allSettled([
				this._fetchService(oCfg.ECC, sDate),
				this._fetchService(oCfg.HANA, sDate)
			]).then(function (aResults) {
				var oEccRes = aResults[0], oHanaRes = aResults[1];

				// Without the HANA side there's nothing to reconcile against.
				if (oHanaRes.status === "rejected") {
					oUi.setProperty("/busy", false);
					var oHErr = oHanaRes.reason;
					MessageBox.error(this._t("loadError") + "\n\n" + (oHErr && oHErr.message ? oHErr.message : oHErr));
					return;
				}

				var bEccFailed = (oEccRes.status === "rejected");
				var aEcc = bEccFailed ? [] : oEccRes.value;
				var aHana = oHanaRes.value;

				// Plant filter + dropdown apply only to types that carry a plant field.
				var sPlantField = oCfg.plantField;
				if (sPlantField) {
					var oPlantSet = {};
					aEcc.concat(aHana).forEach(function (o) {
						var p = String(o[sPlantField] == null ? "" : o[sPlantField]).trim();
						if (p) { oPlantSet[p] = true; }
					});
					oPlantSet.BR10 = true;
					oUi.setProperty("/plants", [{ key: "", text: "All plants" }].concat(
						Object.keys(oPlantSet).sort().map(function (p) { return { key: p, text: p }; })
					));
					var sPlant = (oUi.getProperty("/plant") || "").trim();
					if (sPlant) {
						var fnByPlant = function (o) {
							return String(o[sPlantField] == null ? "" : o[sPlantField]).trim() === sPlant;
						};
						aEcc = aEcc.filter(fnByPlant);
						aHana = aHana.filter(fnByPlant);
					}
				}

				this.getView().getModel("ecc").setProperty("/items", aEcc);
				this.getView().getModel("hana").setProperty("/items", aHana);

				this._reconcile(aEcc, aHana);

				oUi.setProperty("/eccCount", aEcc.length);
				oUi.setProperty("/hanaCount", aHana.length);
				oUi.setProperty("/lastRefreshed", this._now());
				oUi.setProperty("/busy", false);

				var iMissing = this.getView().getModel("missing").getProperty("/items").length;
				if (bEccFailed) {
					MessageToast.show(this._t("eccUnavailable"));
				} else {
					MessageToast.show(this._t("loadDone", [aEcc.length, aHana.length, iMissing]));
					if (iMissing > 0) {
						oUi.setProperty("/selectedTab", "MISSING");
					}
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
		 * Master Data dropdown changed. Datasets/columns differ per type, so clear
		 * everything and let the user re-load for the newly selected type.
		 */
		onMasterDataChange: function () {
			var oUi = this.getView().getModel("ui");
			this.getView().getModel("ecc").setProperty("/items", []);
			this.getView().getModel("hana").setProperty("/items", []);
			this.getView().getModel("missing").setProperty("/items", []);
			oUi.setProperty("/eccCount", 0);
			oUi.setProperty("/hanaCount", 0);
			oUi.setProperty("/missingCount", 0);
			oUi.setProperty("/selectedCount", 0);
			oUi.setProperty("/selectedTab", "ECC");
			// Reset the plant filter to "All plants": each type carries its own
			// plant field (item Plant vs header ReceivingPlant, often blank), so a
			// leftover selection like BR10 would silently filter the new type to 0.
			oUi.setProperty("/plant", "");
			oUi.setProperty("/plants", [{ key: "", text: "All plants" }]);
		},

		/**
		 * Live client-side filter across the visible fields for the active table.
		 */
		onSearch: function (oEvent) {
			var sQuery = (oEvent.getParameter("query") || oEvent.getParameter("newValue") || "").trim();
			var oTable = oEvent.getSource();
			// Walk up to the owning grid table (SearchField sits in the extension toolbar).
			while (oTable && !(oTable.isA && oTable.isA("sap.ui.table.Table"))) {
				oTable = oTable.getParent();
			}
			if (!oTable) {
				return;
			}

			var oBinding = oTable.getBinding("rows");
			if (!oBinding) {
				return;
			}

			if (!sQuery) {
				oBinding.filter([]);
				return;
			}

			var aFieldFilters = this._cfg().FIELDS.map(function (sField) {
				return new Filter(sField, FilterOperator.Contains, sQuery);
			});
			oBinding.filter(new Filter({ filters: aFieldFilters, and: false }));
		},

		onMissingSelectionChange: function () {
			this._updateSelectedCount();
		},

		/**
		 * Select every not-yet-posted row. Operates on the FULL model (not just
		 * rendered rows), which the virtualized grid table supports via index
		 * selection — so it works even with thousands of rows off-screen.
		 */
		onSelectAllPending: function () {
			var oTable = this.byId("tblMissing");
			var aItems = this.getView().getModel("missing").getProperty("/items") || [];

			oTable.clearSelection();
			aItems.forEach(function (oItem, iIndex) {
				if (!oItem.posted) {
					oTable.addSelectionInterval(iIndex, iIndex);
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

			var aContexts = oTable.getSelectedIndices().map(function (iIndex) {
				return oTable.getContextByIndex(iIndex);
			}).filter(function (oCtx) {
				return oCtx && !oModel.getProperty(oCtx.getPath() + "/posted");
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
				oTable.clearSelection();
				this._updateSelectedCount();
				this._refreshMissingCount();
				MessageToast.show(this._t("postAllOk", [aItems.length]) + (sResult ? " — " + sResult : ""));
			}.bind(this)).catch(function (oErr) {
				var sMsg = (oErr && oErr.message) ? oErr.message : String(oErr);
				aContexts.forEach(function (oCtx) {
					oModel.setProperty(oCtx.getPath() + "/posted", false);
					oModel.setProperty(oCtx.getPath() + "/postError", sMsg);
				});
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
			var sUrl = this._serviceBase() + "/" + this._cfg().POST.name;
			var oBody = {};
			oBody[this._cfg().POST.paramName] = aItems;

			var fnPost = function (sToken) {
				return that._ajax(sUrl, "POST", oBody, sToken).then(function (oResp) {
					// An action returning Edm.String comes back as { value: "…" } in V4.
					if (oResp && typeof oResp === "object" && oResp.value !== undefined) {
						return oResp.value;
					}
					return (typeof oResp === "string") ? oResp : "";
				});
			};

			if (this._cfg().POST.useCsrf) {
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
			return this._cfg().KEY_FIELDS.map(function (sField) {
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
			// Normalize OData V2 temporal literals wherever they appear (delivery
			// items expose CreatedOn/Time; headers add Createdon/DeliveryDate/etc.):
			//   "/Date(ms)/" -> yyyy-MM-dd, ISO-8601 duration "PT..." -> HH:mm:ss.
			Object.keys(oOut).forEach(function (sKey) {
				var vVal = oOut[sKey];
				if (typeof vVal === "string") {
					if (vVal.indexOf("/Date(") === 0) {
						oOut[sKey] = this._fromV2Date(vVal);
					} else if (vVal.indexOf("PT") === 0) {
						oOut[sKey] = this._fromIsoDuration(vVal);
					}
				}
			}, this);
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
			var iCount = this.byId("tblMissing").getSelectedIndices().length;
			this.getView().getModel("ui").setProperty("/selectedCount", iCount);
		},

		_refreshMissingCount: function () {
			// "Missing" count reflects rows still outstanding (not yet posted).
			var aItems = this.getView().getModel("missing").getProperty("/items") || [];
			var iOutstanding = aItems.filter(function (o) { return !o.posted; }).length;
			this.getView().getModel("ui").setProperty("/missingCount", iOutstanding);
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
			// Display the refresh timestamp in UTC (not the browser's local zone).
			return oDate.getUTCFullYear() + "-" + pad(oDate.getUTCMonth() + 1) + "-" + pad(oDate.getUTCDate()) +
				" " + pad(oDate.getUTCHours()) + ":" + pad(oDate.getUTCMinutes()) + ":" + pad(oDate.getUTCSeconds()) + " UTC";
		}
	});
});
