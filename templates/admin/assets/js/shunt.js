(function() {
	'use strict';

	var Shunt = (function() {

		function Shunt() {}

		Shunt.prototype.purgeSiteCache = function(siteAlias, callback) {
			var url = '/sites/' + siteAlias;
			var settings = {
				type: 'POST',
				data: { '_method': 'PUT', '_action': 'purge' },
				success: onCachePurgeCompleted,
				error: onCachePurgeFailed
			};
			$.ajax(url, settings);


			function onCachePurgeCompleted() {
				return callback && callback(null);
			}

			function onCachePurgeFailed(jqXHR, textStatus, errorThrown) {
				var error = new Error(errorThrown);
				return callback && callback(error);
			}
		};

		return Shunt;
	})();

	window.shunt = new Shunt();
})();
