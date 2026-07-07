sap.ui.define([
	"sap/ui/core/mvc/Controller"
], function (Controller) {
	"use strict";

	return Controller.extend("com.bluestonex.cloudwmreconcilliationui.controller.App", {

		onInit: function () {
			this._oRouter = this.getOwnerComponent().getRouter();
			// Keep the side-nav highlight in sync with whatever route is showing.
			this._oRouter.attachRouteMatched(this._onRouteMatched, this);
			// Collapse the left rail when the user clicks anywhere outside of it.
			this._fnDocMouseDown = this._onDocumentMouseDown.bind(this);
			document.addEventListener("mousedown", this._fnDocMouseDown, true);
		},

		onExit: function () {
			if (this._fnDocMouseDown) {
				document.removeEventListener("mousedown", this._fnDocMouseDown, true);
			}
		},

		_onRouteMatched: function (oEvent) {
			var oSideNav = this.byId("sideNav");
			if (oSideNav) {
				oSideNav.setSelectedKey(oEvent.getParameter("name"));
			}
		},

		// Clicking outside the expanded rail (and outside the header toggle) collapses it.
		_onDocumentMouseDown: function (oEvent) {
			var oToolPage = this.byId("toolPage");
			if (!oToolPage || !oToolPage.getSideExpanded()) {
				return;
			}
			var oTarget = oEvent.target;
			var oSideNav = this.byId("sideNav");
			var oSideDom = oSideNav && oSideNav.getDomRef();
			if (oSideDom && oSideDom.contains(oTarget)) {
				return; // click landed inside the rail — leave it open
			}
			var oHeaderDom = document.querySelector(".sapTntToolHeader");
			if (oHeaderDom && oHeaderDom.contains(oTarget)) {
				return; // click on the header (incl. the menu toggle) — let the toggle handle it
			}
			oToolPage.setSideExpanded(false);
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
