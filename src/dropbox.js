'use strict';

var Dropbox = require('dropbox');

function DropboxClient(config) {
	this.appKey = config.appKey;
	this.appSecret = config.appSecret;
	this.appToken = config.appToken;
}

DropboxClient.prototype.appKey = null;
DropboxClient.prototype.appSecret = null;
DropboxClient.prototype.client = null;
DropboxClient.prototype.connected = false;

DropboxClient.prototype.connect = function(callback) {
	if (this.client) {
		throw new Error(this.connected ? 'Already connected' : 'Connection attempt already in progress');
	}

	this.client = new Dropbox.Client({
		key: this.appKey,
		secret: this.appSecret,
		token: this.appToken,
		sandbox: false
	});

	var self = this;

	this.client.onError.addListener(function(error) {
		console.warn('Dropbox API error: ' + self.getErrorType(error));
	});
	
	this.client.authenticate(function(error, client) {
		if (error) {
			self.connected = false;
			self.client = null;
			if (callback) { callback(error); }
			return;
		}
		self.connected = true;
		if (callback) { callback(null); }
	});
};

DropboxClient.prototype.loadUserDetails = function(callback) {
	if (!this.connected) { throw new Error('Not connected'); }
	this.client.getAccountInfo(callback);
};

DropboxClient.prototype.getErrorType = function(error) {
	switch (error.status) {
	case Dropbox.ApiError.INVALID_TOKEN:
		// If you're using dropbox.js, the only cause behind this error is that
		// the user token expired.
		// Get the user through the authentication flow again.
		return 'Dropbox.ApiError.INVALID_TOKEN';

	case Dropbox.ApiError.NOT_FOUND:
		// The file or folder you tried to access is not in the user's Dropbox.
		// Handling this error is specific to your application.
		return 'Dropbox.ApiError.INVALID_TOKEN';

	case Dropbox.ApiError.OVER_QUOTA:
		// The user is over their Dropbox quota.
		// Tell them their Dropbox is full. Refreshing the page won't help.
		return 'Dropbox.ApiError.INVALID_TOKEN';

	case Dropbox.ApiError.RATE_LIMITED:
		// Too many API requests. Tell the user to try again later.
		// Long-term, optimize your code to use fewer API calls.
		return 'Dropbox.ApiError.INVALID_TOKEN';

	case Dropbox.ApiError.NETWORK_ERROR:
		// An error occurred at the XMLHttpRequest layer.
		// Most likely, the user's network connection is down.
		// API calls will not succeed until the user gets back online.
		return 'Dropbox.ApiError.INVALID_TOKEN';

	case Dropbox.ApiError.INVALID_PARAM:
		return 'Dropbox.ApiError.INVALID_PARAM';
	case Dropbox.ApiError.OAUTH_ERROR:
		return 'Dropbox.ApiError.OAUTH_ERROR';
	case Dropbox.ApiError.INVALID_METHOD:
		return 'Dropbox.ApiError.INVALID_METHOD';
	default:
		// Caused by a bug in dropbox.js, in your application, or in Dropbox.
		// Tell the user an error occurred, ask them to refresh the page.
	}
};


module.exports = DropboxClient;