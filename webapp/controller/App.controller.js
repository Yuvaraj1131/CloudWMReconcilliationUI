sap.ui.define([
	"sap/ui/core/mvc/Controller"
], function (Controller) {
	"use strict";

	return Controller.extend("com.bluestonex.cloudwmreconcilliationui.controller.App", {

		onInit: function () {
			this._oRouter = this.getOwnerComponent().getRouter();
			// Keep the side-nav highlight in sync with whatever route is showing.
			this._oRouter.attachRouteMatched(this._onRouteMatched, this);
		},

		_onRouteMatched: function (oEvent) {
			var oSideNav = this.byId("sideNav");
			if (oSideNav) {
				oSideNav.setSelectedKey(oEvent.getParameter("name"));
			}
		},

		// A side-nav entry was clicked -> navigate to that app's route.
		onNavItemSelect: function (oEvent) {
			var sKey = oEvent.getParameter("item").getKey();
			this._oRouter.navTo(sKey);
		},

		// Collapse/expand the left rail.
		onMenuToggle: function () {
			var oToolPage = this.byId("toolPage");
			oToolPage.setSideExpanded(!oToolPage.getSideExpanded());
		}
	});
});
