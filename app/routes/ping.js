module.exports = (function() {
	'use strict';

	var express = require('express');
	var app = express();

	app.get('/', function(req, res) {
		res.send(204);
	});

	return app;
})();
