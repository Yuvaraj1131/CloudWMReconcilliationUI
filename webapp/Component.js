sap.ui.define([
	"sap/ui/core/UIComponent",
	"sap/ui/Device",
	"com/bluestonex/cloudwmreconcilliationui/model/models"
], function (UIComponent, Device, models) {
	"use strict";

	return UIComponent.extend("com.bluestonex.cloudwmreconcilliationui.Component", {

		metadata: {
			manifest: "json",
			interfaces: ["sap.ui.core.IAsyncContentCreation"]
		},

		/**
		 * The component is initialized by UI5 automatically during the startup of the app
		 * and calls the init method once.
		 */
		init: function () {
			// call the base component's init function
			UIComponent.prototype.init.apply(this, arguments);

			// set the device model (handy for responsive bindings in the view)
			this.setModel(models.createDeviceModel(), "device");

			// start the router so the shell can navigate between apps
			this.getRouter().initialize();
		}
	});
});
