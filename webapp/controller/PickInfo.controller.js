sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageToast"
], function (Controller, JSONModel, MessageToast) {
	"use strict";

	// ---------------------------------------------------------------------
	//  MOCK data. Replace onGetPick with a real service call later (e.g. a
	//  CAP function getPickInfo(PickNo=...) — same pattern as the ECC/HANA
	//  functions in the Reconciliation controller).
	// ---------------------------------------------------------------------
	var PICKERS = ["A. Muller", "S. Rodrigues", "K. Tanaka", "J. Smith", "L. Costa"];
	var STATUSES = [
		{ text: "Completed", state: "Success" },
		{ text: "In Process", state: "Warning" },
		{ text: "Open", state: "Information" },
		{ text: "Error", state: "Error" }
	];

	return Controller.extend("com.bluestonex.cloudwmreconcilliationui.controller.PickInfo", {

		onInit: function () {
			this.getView().setModel(new JSONModel({
				pickNo: "",
				hasResult: false,
				result: {},
				// resolve the SVG path via the module system so it works in BAS
				// preview AND once deployed (no fragile relative paths)
				artUrl: sap.ui.require.toUrl("com/bluestonex/cloudwmreconcilliationui/img/picker-animation.svg")
			}), "pick");
		},

		onGetPick: function () {
			var oModel = this.getView().getModel("pick");
			var sPick = (oModel.getProperty("/pickNo") || "").trim();

			if (!sPick) {
				MessageToast.show(this._t("pickNotFound"));
				return;
			}

			// Deterministic mock: same PICK number always yields the same details.
			var iHash = 0;
			for (var i = 0; i < sPick.length; i++) {
				iHash += sPick.charCodeAt(i);
			}
			var oStatus = STATUSES[iHash % STATUSES.length];
			var pad = function (n) { return String(n).padStart(2, "0"); };

			oModel.setProperty("/result", {
				PickNo: sPick,
				Picker: PICKERS[iHash % PICKERS.length],
				Time: "2026-06-22 " + pad(8 + (iHash % 9)) + ":" + pad(10 + (iHash % 49)) + ":00",
				Status: oStatus.text,
				StatusState: oStatus.state,
				Warehouse: "BR" + (1 + (iHash % 3)),
				Items: String(1 + (iHash % 12))
			});
			oModel.setProperty("/hasResult", true);
		},

		_t: function (sKey) {
			return this.getView().getModel("i18n").getResourceBundle().getText(sKey);
		}
	});
});
