sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageToast",
	"sap/m/MessageBox"
], function (Controller, JSONModel, MessageToast, MessageBox) {
	"use strict";

	// =====================================================================
	//  CONFIG — CAP "ReconcileServices" (OData V4, HANA-backed).
	//    Pick Task   : getPickTaskDetails(ID='PICK_62070')                       -> 1 header
	//    Picker Logs : getPickUserLogs(User_ID='DA94923519', EventDate=2026-…)   -> events
	//                  getPickUserLogs(EventDate=2026-…)                          -> ALL pickers that day
	//  NOTE: getPickUserLogs needs EventDate (required) and User_ID (optional) in
	//  the CAP function signature — see the deploy notes.
	// =====================================================================
	var CONFIG = {
		SERVICE_BASE: "/ReconcileServices",
		TASK: { name: "getPickTaskDetails", param: "ID" },
		LOGS: { name: "getPickUserLogs", param: "User_ID", dateParam: "EventDate" }
	};

	// A pick is "completed" once it reaches the marshalling hand-off.
	var COMPLETE_EVENT = "MARSHALLING_AREA_CONFIRMED";

	function eventState(sType) {
		var t = String(sType || "");
		if (/MARSHALLING|CONFIRMED/.test(t)) { return "Success"; }
		if (/EXITED|SHORTED|ERROR|FAIL|REJECT/.test(t)) { return "Warning"; }
		if (/REQUESTED|RESUMED|SCAN|ENTERED/.test(t)) { return "Information"; }
		return "None";
	}

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
				mode: "TASK",          // "TASK" (by Pick ID) | "LOGS" (by date, optional user)
				query: "",
				date: this._today(),
				busy: false,
				hasTask: false,
				hasLogs: false,
				task: {},
				tree: [],
				summary: {},
				artUrl: sap.ui.require.toUrl("com/bluestonex/cloudwmreconcilliationui/img/picker-animation.svg")
			}), "pick");
			this._aLogs = [];   // flat enriched events, kept for client-side search
		},

		onModeChange: function () {
			var oModel = this.getView().getModel("pick");
			oModel.setProperty("/hasTask", false);
			oModel.setProperty("/hasLogs", false);
			oModel.setProperty("/query", "");
		},

		onGetPick: function () {
			var oModel = this.getView().getModel("pick");
			var sMode = oModel.getProperty("/mode");
			var sQuery = (oModel.getProperty("/query") || "").trim();
			var sUrl;

			if (sMode === "LOGS") {
				// Date is required; User_ID is optional (omit -> all pickers that day).
				var sDate = oModel.getProperty("/date");
				if (!sDate) {
					MessageToast.show(this._t("pickPickDate"));
					return;
				}
				var sUser = sQuery ? (CONFIG.LOGS.param + "='" + encodeURIComponent(sQuery) + "',") : "";
				sUrl = CONFIG.SERVICE_BASE + "/" + CONFIG.LOGS.name + "(" + sUser + CONFIG.LOGS.dateParam + "=" + sDate + ")";
			} else {
				if (!sQuery) {
					MessageToast.show(this._t("pickEnterValue"));
					return;
				}
				sUrl = CONFIG.SERVICE_BASE + "/" + CONFIG.TASK.name + "(" + CONFIG.TASK.param + "='" + encodeURIComponent(sQuery) + "')";
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

			var oTasks = {}, oCompleted = {}, oUsers = {};
			aLogs.forEach(function (e) {
				e._event = String(e.EVENT_TYPE || "").replace(/_/g, " ");
				e._ts = String(e.EVENT_TIMESTAMP || "").replace("T", " ").slice(0, 19);
				e._level = e.LEVEL === "H" ? "Header" : (e.LEVEL === "I" ? "Item" : (e.LEVEL || ""));
				e._state = eventState(e.EVENT_TYPE);
				if (e.PICKTASK_ID) {
					oTasks[e.PICKTASK_ID] = true;
					if (e.EVENT_TYPE === COMPLETE_EVENT) { oCompleted[e.PICKTASK_ID] = true; }
				}
				if (e.USER_ID) { oUsers[e.USER_ID] = true; }
			});

			this._aLogs = aLogs;
			oModel.setProperty("/tree", this._buildTree(aLogs));

			var aUsers = Object.keys(oUsers);
			oModel.setProperty("/summary", {
				user: aUsers.length === 1 ? aUsers[0] : "",   // shown when a single picker
				pickers: aUsers.length,
				events: aLogs.length,
				tasks: Object.keys(oTasks).length,
				completed: Object.keys(oCompleted).length
			});
			oModel.setProperty("/hasLogs", true);
			oModel.setProperty("/hasTask", false);
		},

		// Group flat events into a 2-level tree: pick task -> its events.
		_buildTree: function (aEvents) {
			var oByPick = {}, aOrder = [];
			aEvents.forEach(function (e) {
				var sPid = e.PICKTASK_ID || "(none)";
				var oNode = oByPick[sPid];
				if (!oNode) {
					oNode = oByPick[sPid] = {
						isPick: true, PICKTASK_ID: sPid, user: e.USER_ID || "",
						children: [], _completed: false, _lastTs: e.EVENT_TIMESTAMP || "",
						_ts: "", ITEM_ID: "", QUANTITY: null, _level: ""
					};
					aOrder.push(sPid);
				}
				oNode.children.push(e);
				if (e.EVENT_TYPE === COMPLETE_EVENT) { oNode._completed = true; }
				if (String(e.EVENT_TIMESTAMP) > String(oNode._lastTs)) { oNode._lastTs = e.EVENT_TIMESTAMP; }
			});

			var that = this;
			var aTree = aOrder.map(function (sPid) {
				var oNode = oByPick[sPid];
				oNode.count = oNode.children.length;
				oNode._event = oNode.count + " " + that._t("pickEvents");
				oNode._state = oNode._completed ? "Success" : "Information";
				oNode.children.sort(function (a, b) {
					return String(b.EVENT_TIMESTAMP).localeCompare(String(a.EVENT_TIMESTAMP));
				});
				return oNode;
			});
			// newest pick (by latest event) first
			aTree.sort(function (a, b) { return String(b._lastTs).localeCompare(String(a._lastTs)); });
			return aTree;
		},

		// Client-side search: re-filter the cached events and rebuild the tree.
		onLogSearch: function (oEvent) {
			var sQuery = (oEvent.getParameter("query") || oEvent.getParameter("newValue") || "").trim().toLowerCase();
			var aAll = this._aLogs || [];
			var aFiltered = !sQuery ? aAll : aAll.filter(function (e) {
				return [e.PICKTASK_ID, e._event, e.ITEM_ID, e.USER_ID].some(function (v) {
					return String(v || "").toLowerCase().indexOf(sQuery) !== -1;
				});
			});
			this.getView().getModel("pick").setProperty("/tree", this._buildTree(aFiltered));
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
