'use strict';

var assert = require('assert');
var path = require('path');
var mkdirp = require('mkdirp');
var Jimp = require('jimp');

function ThumbnailService() {
}

ThumbnailService.prototype.saveThumbnail = function(source, options) {
	options = options || {};
	var destination = options.destination;
	var width = options.width;
	var height = options.height;

	try {
		assert(source, 'Missing source path');
		assert(destination, 'Missing destination path');
		assert(width, 'Missing width');
		assert(height, 'Missing height');
	} catch (error) {
		return Promise.reject(error);
	}

	return Jimp.read(source)
		.then(function(image) {
			return ensureDirectoryExists(path.dirname(destination))
				.then(function() {
					return new Promise(function(resolve, reject) {
						var originalWidth = image.bitmap.width;
						var originalHeight = image.bitmap.height;
						var ratio = Math.min(width / originalWidth, height / originalHeight);
						image
							.scale(ratio)
							.write(destination, function(error) {
								if (error) { return reject(error); }
								resolve();
							});
					});
				});
		});
};

module.exports = ThumbnailService;


function ensureDirectoryExists(path) {
	return new Promise(function(resolve, reject) {
		mkdirp(path, function(error) {
			if (error) { return reject(error); }
			resolve(error);
		});
	});
}
