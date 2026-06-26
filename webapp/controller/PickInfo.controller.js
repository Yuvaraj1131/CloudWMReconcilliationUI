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
	//  CONFIG — CAP "ReconcileServices" (OData V4, HANA-backed).
	//    Pick Task   : getPickTaskDetails(ID='PICK_62070')                 -> 1 header
	//    Picker Logs : getPickUserLogs(User_ID='DA94923519', EventDate=…)  -> N events for that DAY
	//  NOTE: getPickUserLogs needs the EventDate parameter added in the CAP
	//  handler (see the deploy notes) so we don't pull a picker's whole history.
	// =====================================================================
	var CONFIG = {
		SERVICE_BASE: "/ReconcileServices",
		TASK: { name: "getPickTaskDetails", param: "ID" },
		LOGS: { name: "getPickUserLogs", param: "User_ID", dateParam: "EventDate" }
	};

	// A pick is treated as "completed" once it reaches the marshalling hand-off.
	var COMPLETE_EVENT = "MARSHALLING_AREA_CONFIRMED";

	// Colour an event by its type so the log reads at a glance.
	function eventState(sType) {
		var t = String(sType || "");
		if (/MARSHALLING|CONFIRMED/.test(t)) { return "Success"; }
		if (/EXITED|SHORTED|ERROR|FAIL|REJECT/.test(t)) { return "Warning"; }
		if (/REQUESTED|RESUMED|SCAN|ENTERED/.test(t)) { return "Information"; }
		return "None";
	}

	// Colour a pick-task status.
	function statusState(sStatus) {
		var s = String(sStatus || "").toUpperCase();
		if (s === "COMPLETED") { return "Success"; }
		if (s === "NOTRELEASED") { return "Warning"; }
		if (/PROGRESS|PARTIAL|PICKING|RELEASED/.test(s)) { return "Information"; }
		return "None";
	}

	return Controller.extend("com.bluestonex.cloudwmreconcilliationui.controller.PickInfo", {

		onInit: function () {
			this.getView().setModel(new JSONModel({
				mode: "TASK",          // "TASK" (by Pick ID) | "LOGS" (by Picker/User ID + date)
				query: "",
				date: this._today(),   // only used in LOGS mode
				busy: false,
				hasTask: false,
				hasLogs: false,
				task: {},
				logs: [],
				summary: {},
				artUrl: sap.ui.require.toUrl("com/bluestonex/cloudwmreconcilliationui/img/picker-animation.svg")
			}), "pick");
		},

		onModeChange: function () {
			var oModel = this.getView().getModel("pick");
			oModel.setProperty("/hasTask", false);
			oModel.setProperty("/hasLogs", false);
			oModel.setProperty("/query", "");
		},

		onGetPick: function () {
			var oModel = this.getView().getModel("pick");
			var sQuery = (oModel.getProperty("/query") || "").trim();
			if (!sQuery) {
				MessageToast.show(this._t("pickEnterValue"));
				return;
			}

			var sMode = oModel.getProperty("/mode");
			var sUrl;
			if (sMode === "LOGS") {
				var sDate = oModel.getProperty("/date");
				if (!sDate) {
					MessageToast.show(this._t("pickPickDate"));
					return;
				}
				// string key in single quotes; Edm.Date literal is bare (no quotes)
				sUrl = CONFIG.SERVICE_BASE + "/" + CONFIG.LOGS.name +
					"(" + CONFIG.LOGS.param + "='" + encodeURIComponent(sQuery) + "'," +
					CONFIG.LOGS.dateParam + "=" + sDate + ")";
			} else {
				sUrl = CONFIG.SERVICE_BASE + "/" + CONFIG.TASK.name +
					"(" + CONFIG.TASK.param + "='" + encodeURIComponent(sQuery) + "')";
			}

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
			oTask._statusState = statusState(oTask.STATUS_ID);
			oModel.setProperty("/task", oTask);
			oModel.setProperty("/hasTask", true);
			oModel.setProperty("/hasLogs", false);
		},

		_showLogs: function (aRows) {
			var oModel = this.getView().getModel("pick");
			var aLogs = (aRows || []).slice();
			if (!aLogs.length) {
				oModel.setProperty("/hasLogs", false);
				MessageToast.show(this._t("pickNoResult"));
				return;
			}

			// newest first
			aLogs.sort(function (a, b) {
				return String(b.EVENT_TIMESTAMP || "").localeCompare(String(a.EVENT_TIMESTAMP || ""));
			});

			var oTasks = {};
			var oCompleted = {};
			aLogs.forEach(function (e) {
				e._event = String(e.EVENT_TYPE || "").replace(/_/g, " ");
				e._ts = String(e.EVENT_TIMESTAMP || "").replace("T", " ").slice(0, 19);
				e._level = e.LEVEL === "H" ? "Header" : (e.LEVEL === "I" ? "Item" : (e.LEVEL || ""));
				e._state = eventState(e.EVENT_TYPE);
				if (e.PICKTASK_ID) {
					oTasks[e.PICKTASK_ID] = true;
					if (e.EVENT_TYPE === COMPLETE_EVENT) {
						oCompleted[e.PICKTASK_ID] = true;
					}
				}
			});

			oModel.setProperty("/logs", aLogs);
			oModel.setProperty("/summary", {
				user: aLogs[0].USER_ID || "",
				events: aLogs.length,
				tasks: Object.keys(oTasks).length,
				completed: Object.keys(oCompleted).length
			});
			oModel.setProperty("/hasLogs", true);
			oModel.setProperty("/hasTask", false);
		},

		// Live client-side filter of the (grouped) logs table.
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
			var aFilters = ["PICKTASK_ID", "_event", "ITEM_ID"].map(function (sField) {
				return new Filter(sField, FilterOperator.Contains, sQuery);
			});
			oBinding.filter(new Filter({ filters: aFilters, and: false }));
		},

		/* ============================================================= */
		/*  SERVICE I/O                                                  */
		/* ============================================================= */

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
		},

		_today: function () {
			var oDate = new Date();
			var pad = function (n) { return String(n).padStart(2, "0"); };
			return oDate.getFullYear() + "-" + pad(oDate.getMonth() + 1) + "-" + pad(oDate.getDate());
		}
	});
});
