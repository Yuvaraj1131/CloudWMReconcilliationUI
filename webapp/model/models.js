sap.ui.define([
	"sap/ui/model/json/JSONModel",
	"sap/ui/Device"
], function (JSONModel, Device) {
	"use strict";

	return {
		/**
		 * Provides a device model used for responsive bindings in the views.
		 * @returns {sap.ui.model.json.JSONModel} the device model (read-only, OneWay).
		 */
		createDeviceModel: function () {
			var oModel = new JSONModel(Device);
			oModel.setDefaultBindingMode("OneWay");
			return oModel;
		}
	};
});
