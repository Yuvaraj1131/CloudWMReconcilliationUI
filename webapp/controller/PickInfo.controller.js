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
	//  CONFIG — Pick Info reads from the CAP "ReconcileServices" (OData V4,
	//  backed by HANA). Two unbound functions, each taking one string key:
	//    Pick Task   : getPickTaskDetails(ID='PICK_62070')        -> 1 header
	//    Picker Logs : getPickUserLogs(User_ID='DA94923519')      -> N events
	//  Relative path -> reached through the CloudWMReconcilliation destination.
	// =====================================================================
	var CONFIG = {
		SERVICE_BASE: "/ReconcileServices",
		TASK: { name: "getPickTaskDetails", param: "ID" },
		LOGS: { name: "getPickUserLogs", param: "User_ID" }
	};

	return Controller.extend("com.bluestonex.cloudwmreconcilliationui.controller.PickInfo", {

		onInit: function () {
			this.getView().setModel(new JSONModel({
				mode: "TASK",          // "TASK" (by Pick ID) | "LOGS" (by Picker/User ID)
				query: "",
				busy: false,
				hasTask: false,
				hasLogs: false,
				task: {},
				logs: [],
				summary: {},
				// resolve the SVG path via the module system so it works in BAS
				// preview AND once deployed (no fragile relative paths)
				artUrl: sap.ui.require.toUrl("com/bluestonex/cloudwmreconcilliationui/img/picker-animation.svg")
			}), "pick");
		},

		// Switching the lookup mode clears the previous result.
		onModeChange: function () {
			var oModel = this.getView().getModel("pick");
			oModel.setProperty("/hasTask", false);
			oModel.setProperty("/hasLogs", false);
			oModel.setProperty("/query", "");
		},

		// Look up either a pick task or a picker's activity log, depending on mode.
		onGetPick: function () {
			var oModel = this.getView().getModel("pick");
			var sQuery = (oModel.getProperty("/query") || "").trim();
			if (!sQuery) {
				MessageToast.show(this._t("pickEnterValue"));
				return;
			}

			var sMode = oModel.getProperty("/mode");
			var oFn = (sMode === "LOGS") ? CONFIG.LOGS : CONFIG.TASK;
			// OData V4 unbound function call, string key wrapped in single quotes.
			var sUrl = CONFIG.SERVICE_BASE + "/" + oFn.name + "(" + oFn.param + "='" + encodeURIComponent(sQuery) + "')";

			oModel.setProperty("/busy", true);
			this._ajax(sUrl).then(function (aRows) {
				if (sMode === "LOGS") {
					this._showLogs(aRows);
				} else {
					this._showTask(aRows);
				}
			}.bind(this)).catch(function (oErr) {
				oModel.setProperty("/hasTask", false);
				oModel.setProperty("/hasLogs", false);
				MessageBox.error(this._t("pickError") + "\n\n" + (oErr && oErr.message ? oErr.message : oErr));
			}.bind(this)).then(function () {
				oModel.setProperty("/busy", false);
			});
		},

		/* ============================================================= */
		/*  RESULT HANDLERS                                              */
		/* ============================================================= */

		_showTask: function (aRows) {
			var oModel = this.getView().getModel("pick");
			var oTask = (aRows && aRows.length) ? aRows[0] : null;
			if (!oTask) {
				oModel.setProperty("/hasTask", false);
				MessageToast.show(this._t("pickNoResult"));
				return;
			}
			oModel.setProperty("/task", oTask);
			oModel.setProperty("/hasTask", true);
			oModel.setProperty("/hasLogs", false);
		},

		_showLogs: function (aRows) {
			var oModel = this.getView().getModel("pick");
			var aLogs = (aRows || []).slice();

			// newest first
			aLogs.sort(function (a, b) {
				return String(b.EVENT_TIMESTAMP || "").localeCompare(String(a.EVENT_TIMESTAMP || ""));
			});

			// derived display fields (don't mutate meaning, just presentation)
			var oTaskSet = {};
			aLogs.forEach(function (e) {
				e._event = String(e.EVENT_TYPE || "").replace(/_/g, " ");
				e._ts = String(e.EVENT_TIMESTAMP || "").replace("T", " ").slice(0, 19);
				e._level = e.LEVEL === "H" ? "Header" : (e.LEVEL === "I" ? "Item" : (e.LEVEL || ""));
				if (e.PICKTASK_ID) {
					oTaskSet[e.PICKTASK_ID] = true;
				}
			});

			if (!aLogs.length) {
				oModel.setProperty("/hasLogs", false);
				MessageToast.show(this._t("pickNoResult"));
				return;
			}

			oModel.setProperty("/logs", aLogs);
			oModel.setProperty("/summary", {
				user: aLogs[0].USER_ID || "",
				events: aLogs.length,
				tasks: Object.keys(oTaskSet).length
			});
			oModel.setProperty("/hasLogs", true);
			oModel.setProperty("/hasTask", false);
		},

		// Live client-side filter of the logs table.
		onLogSearch: function (oEvent) {
			var sQuery = (oEvent.getParameter("query") || oEvent.getParameter("newValue") || "").trim();
			var oBinding = this.byId("logsTable").getBinding("items");
			if (!oBinding) {
				return;
			}
			if (!sQuery) {
				oBinding.filter([]);
				return;
			}
			var aFilters = ["PICKTASK_ID", "_event", "ITEM_ID", "USER_ID"].map(function (sField) {
				return new Filter(sField, FilterOperator.Contains, sQuery);
			});
			oBinding.filter(new Filter({ filters: aFilters, and: false }));
		},

		/* ============================================================= */
		/*  SERVICE I/O                                                  */
		/* ============================================================= */

		// GET the function URL and return the OData V4 "value" array.
		_ajax: function (sUrl) {
			return new Promise(function (resolve, reject) {
				var oXhr = new XMLHttpRequest();
				oXhr.open("GET", sUrl, true);
				oXhr.setRequestHeader("Accept", "application/json");
				oXhr.onload = function () {
					if (oXhr.status >= 200 && oXhr.status < 300) {
						var oData = oXhr.responseText ? JSON.parse(oXhr.responseText) : {};
						if (Array.isArray(oData)) {
							resolve(oData);
						} else if (Array.isArray(oData.value)) {
							resolve(oData.value);
						} else if (oData && typeof oData === "object") {
							resolve([oData]);
						} else {
							resolve([]);
						}
					} else {
						reject(new Error("HTTP " + oXhr.status + " " + oXhr.statusText + (oXhr.responseText ? " — " + oXhr.responseText.slice(0, 400) : "")));
					}
				};
				oXhr.onerror = function () {
					reject(new Error("Network error calling " + sUrl));
				};
				oXhr.send(null);
			});
		},

		_t: function (sKey) {
			return this.getView().getModel("i18n").getResourceBundle().getText(sKey);
		}
	});
});
