'use strict';

var assert = require('assert');
var dns = require('dns');

var HttpError = require('../errors/HttpError');
var getIsSameHost = require('../utils/getIsSameHost');

module.exports = function(options) {
	options = options || {};
	var hostname = options.hostname;

	assert(hostname, 'Missing hostname');

	return function(req, res, next) {
		var isCustomDomain = !getIsSameHost(req.host, hostname);
		if (!isCustomDomain) {
			return next();
		}
		dns.resolveCname(req.host, function(error, cnames) {
			if (error && (error.code === 'ENODATA' || error.code === 'ENOTFOUND')) {
				error = null;
				cnames = null;
			}
			if (error) { return next(error); }
			if (!cnames || (cnames.length === 0)) {
				return next(new HttpError(403, 'Invalid host: ' + req.host));
			}
			var cname = cnames[0];
			res.locals.originalHost = req.host;
			req.headers.host = cname;
			next();
		});
	};
};
