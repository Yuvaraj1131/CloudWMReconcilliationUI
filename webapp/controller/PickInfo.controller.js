sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/ui/export/Spreadsheet",
	"sap/m/MessageToast",
	"sap/m/MessageBox"
], function (Controller, JSONModel, Spreadsheet, MessageToast, MessageBox) {
	"use strict";

	// =====================================================================
	//  CONFIG — CAP "ReconcileServices" (OData V4, HANA-backed).
	//    Pick Task   : getPickTaskDetails(ID='PICK_62070')                     -> 1 header
	//    Picker Logs : getPickUserLogs(User_ID='DA94923519', EventDate=…)      -> a picker's day
	//                  getPickUserLogs(EventDate=…)                            -> ALL pickers that day
	// =====================================================================
	var CONFIG = {
		// Resolve relative to the app mount (see Reconciliation.controller): an
		// absolute "/ReconcileServices" 404s under the deployed Work Zone approuter.
		SERVICE_BASE: sap.ui.require.toUrl("com/bluestonex/cloudwmreconcilliationui") + "/ReconcileServices",
		TASK: { name: "getPickTaskDetails", param: "ID" },
		ITEMS: { name: "getPickTaskItems", param: "ID" },
		LOGS: { name: "getPickUserLogs", param: "User_ID", dateParam: "EventDate" }
	};

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
				mode: "TASK",
				query: "",
				date: this._today(),
				busy: false,
				hasTask: false,
				hasLogs: false,
				task: {},
				items: [],
				tree: [],
				summary: {},
				artUrl: sap.ui.require.toUrl("com/bluestonex/cloudwmreconcilliationui/img/picker-animation.svg")
			}), "pick");
			this._aLogs = [];
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
				oModel.setProperty("/items", []);
				MessageToast.show(this._t("pickNoResult"));
				return;
			}
			oTask._statusState = statusState(oTask.STATUS_ID);
			oModel.setProperty("/task", oTask);
			oModel.setProperty("/hasTask", true);
			oModel.setProperty("/hasLogs", false);
			// Load the item lines for this pick task and show them below the header.
			this._loadTaskItems(oTask.ID);
		},

		// Fetch the pick-task item lines (getPickTaskItems) for a header ID.
		_loadTaskItems: function (sId) {
			var oModel = this.getView().getModel("pick");
			oModel.setProperty("/items", []);
			if (!sId) { return; }
			var sUrl = CONFIG.SERVICE_BASE + "/" + CONFIG.ITEMS.name +
				"(" + CONFIG.ITEMS.param + "='" + encodeURIComponent(sId) + "')";
			this._ajax(sUrl).then(function (aRows) {
				oModel.setProperty("/items", Array.isArray(aRows) ? aRows : []);
			}).catch(function () {
				oModel.setProperty("/items", []);
			});
		},

		_showLogs: function (aRows) {
			var oModel = this.getView().getModel("pick");
			var aLogs = (aRows || []).slice();
			if (!aLogs.length) {
				oModel.setProperty("/hasLogs", false);
				MessageToast.show(this._t("pickNoResult"));
				return;
			}

			var oTasks = {}, oCompleted = {}, oUsers = {}, aTimes = [];
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
				if (e.EVENT_TIMESTAMP) { aTimes.push(e.EVENT_TIMESTAMP); }
			});

			this._aLogs = aLogs;
			oModel.setProperty("/tree", this._buildTree(aLogs));

			aTimes.sort();
			var aUsers = Object.keys(oUsers);
			oModel.setProperty("/summary", {
				user: aUsers.length === 1 ? aUsers[0] : "",
				scope: aUsers.length === 1 ? aUsers[0] : (this._t("pickAllPickers") + " (" + aUsers.length + ")"),
				pickers: aUsers.length,
				events: aLogs.length,
				tasks: Object.keys(oTasks).length,
				completed: Object.keys(oCompleted).length,
				date: oModel.getProperty("/date"),
				from: aTimes.length ? aTimes[0].slice(11, 16) : "",
				to: aTimes.length ? aTimes[aTimes.length - 1].slice(11, 16) : ""
			});
			oModel.setProperty("/hasLogs", true);
			oModel.setProperty("/hasTask", false);
		},

		// Build a 3-level tree: User -> Pick task -> Events.
		_buildTree: function (aEvents) {
			var that = this;
			var oByUser = {}, aUserOrder = [];

			aEvents.forEach(function (e) {
				var sUid = e.USER_ID || "(unknown)";
				var oUser = oByUser[sUid];
				if (!oUser) {
					oUser = oByUser[sUid] = {
						isUser: true, USER_ID: sUid, _picks: {}, _pickOrder: [],
						_lastTs: e.EVENT_TIMESTAMP || "", children: [],
						ITEM_ID: "", QUANTITY: null, _level: ""
					};
					aUserOrder.push(sUid);
				}
				var sPid = e.PICKTASK_ID || "(none)";
				var oPick = oUser._picks[sPid];
				if (!oPick) {
					oPick = oUser._picks[sPid] = {
						isPick: true, PICKTASK_ID: sPid, children: [],
						_completed: false, _lastTs: e.EVENT_TIMESTAMP || "",
						ITEM_ID: "", QUANTITY: null, _level: ""
					};
					oUser._pickOrder.push(sPid);
				}
				oPick.children.push(e);
				if (e.EVENT_TYPE === COMPLETE_EVENT) { oPick._completed = true; }
				if (String(e.EVENT_TIMESTAMP) > String(oPick._lastTs)) { oPick._lastTs = e.EVENT_TIMESTAMP; }
				if (String(e.EVENT_TIMESTAMP) > String(oUser._lastTs)) { oUser._lastTs = e.EVENT_TIMESTAMP; }
			});

			return aUserOrder.map(function (sUid) {
				var oUser = oByUser[sUid];
				var aPicks = oUser._pickOrder.map(function (sPid) {
					var oPick = oUser._picks[sPid];
					oPick.count = oPick.children.length;
					oPick._event = oPick.count + " " + that._t("pickEvents");
					oPick._state = oPick._completed ? "Success" : "Information";
					oPick.children.sort(function (a, b) {
						return String(b.EVENT_TIMESTAMP).localeCompare(String(a.EVENT_TIMESTAMP));
					});
					return oPick;
				});
				aPicks.sort(function (a, b) { return String(b._lastTs).localeCompare(String(a._lastTs)); });

				var iDone = aPicks.filter(function (p) { return p._completed; }).length;
				oUser.children = aPicks;
				oUser.count = aPicks.length;
				oUser._event = aPicks.length + " " + that._t("pickTasks") + " · " + iDone + " " + that._t("pickCompleted");
				oUser._state = (iDone === aPicks.length && iDone > 0) ? "Success" : "Information";
				delete oUser._picks;
				delete oUser._pickOrder;
				return oUser;
			}).sort(function (a, b) { return String(b._lastTs).localeCompare(String(a._lastTs)); });
		},

		// Client-side search: re-filter the cached events and rebuild the tree.
		onLogSearch: function (oEvent) {
			var sQuery = (oEvent.getParameter("query") || oEvent.getParameter("newValue") || "").trim().toLowerCase();
			var aAll = this._aLogs || [];
			var aFiltered = !sQuery ? aAll : aAll.filter(function (e) {
				return [e.USER_ID, e.PICKTASK_ID, e._event, e.ITEM_ID].some(function (v) {
					return String(v || "").toLowerCase().indexOf(sQuery) !== -1;
				});
			});
			this.getView().getModel("pick").setProperty("/tree", this._buildTree(aFiltered));
		},

		// Export the (flat) activity to an .xlsx file.
		onExportExcel: function () {
			var aData = this._aLogs || [];
			if (!aData.length) {
				MessageToast.show(this._t("pickNoResult"));
				return;
			}
			var aColumns = [
				{ label: this._t("pickColPicker"), property: "USER_ID" },
				{ label: this._t("pickColTask"), property: "PICKTASK_ID" },
				{ label: this._t("pickColTime"), property: "_ts" },
				{ label: this._t("pickColEvent"), property: "_event" },
				{ label: this._t("pickColItem"), property: "ITEM_ID" },
				{ label: this._t("pickColQty"), property: "QUANTITY" },
				{ label: this._t("pickColLevel"), property: "_level" }
			];
			var oSheet = new Spreadsheet({
				workbook: { columns: aColumns },
				dataSource: aData,
				fileName: "PickerActivity_" + (this.getView().getModel("pick").getProperty("/date") || "") + ".xlsx",
				worker: false
			});
			oSheet.build().finally(function () { oSheet.destroy(); });
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
