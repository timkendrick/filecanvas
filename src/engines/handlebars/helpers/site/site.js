'use strict';

var path = require('path');
var isUrl = require('is-url');
var bytes = require('bytes');

module.exports['login'] = function(rootModel) {
	return rootModel.metadata.siteRoot + 'login';
};
module.exports['logout'] = function(rootModel) {
	return rootModel.metadata.siteRoot + 'logout';
};
module.exports['asset'] = function(rootModel, filePath) {
	return isUrl(filePath) ? filePath : rootModel.metadata.themeRoot + filePath;
};
module.exports['download'] = function(rootModel, file) {
	if (!file || !file.path) { return null; }
	return rootModel.metadata.siteRoot + 'download' + file.path;
};
module.exports['preview'] = function(rootModel, file) {
	if (!file || !file.path) { return null; }
	return rootModel.metadata.siteRoot + 'preview' + file.path;
};
module.exports['thumbnail'] = function(rootModel, file) {
	if (!file || !file.path) { return null; }
	return rootModel.metadata.siteRoot + 'thumbnail' + file.path;
};
module.exports['shortcut'] = function(rootModel, file) {
	if (!file || !file.path) { return null; }
	return rootModel.metadata.siteRoot + 'redirect' + file.path;
};
module.exports['extension'] = function(file, options) {
	if (!file || !file.path) { return null; }
	return path.extname(file.path).replace(/^\./, '');
};
module.exports['filesize'] = function(file, options) {
	if (!file || !file.size) { return null; }
	return bytes.format(file.size, { decimalPlaces: 1 }).toUpperCase();
};
module.exports['strip-number-prefix'] = function(file, options) {
	if (!file || !file.path) { return null; }
	var label = path.basename(file.path, path.extname(file.path));
	return stripLeadingNumber(label);
};
module.exports['is-shortcut'] = function(file) {
	var extension = path.extname(file.path);
	var SHORTCUT_EXTENSIONS = ['.url', '.webloc', '.desktop'];
	var isShortcutFile = (SHORTCUT_EXTENSIONS.indexOf(extension) !== -1);
	return isShortcutFile;
};
module.exports['has-preview'] = function(file) {
	var extension = path.extname(file.path);
	var PREVIEW_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.htm', '.html', '.txt', '.pdf'];
	var hasPreview = (PREVIEW_EXTENSIONS.indexOf(extension) !== -1);
	return hasPreview;
};
module.exports['files'] = function(file, options) {
	if (!file || !file.contents) { return null; }
	return file.contents.filter(function(file) {
		return !file.directory;
	}).sort(function(file1, file2) {
		return sortByPrefixedFilename(file1, file2) || sortByLastModified(file1, file2);
	});
};
module.exports['folders'] = function(file, options) {
	if (!file || !file.contents) { return null; }
	return file.contents.filter(function(file) {
		return file.directory;
	}).sort(function(file1, file2) {
		return sortByPrefixedFilename(file1, file2) || sortByFilename(file1, file2);
	});
};
module.exports['flattenedFiles'] = function(file, options) {
	if (!file || !file.contents) { return null; }
	return file.contents.reduce(function getDirectoryFiles(files, file) {
		return files.concat(file.directory ? file.contents.reduce(getDirectoryFiles, []) : [file]);
	}, []).sort(function(file1, file2) {
		return sortByPrefixedFilename(file1, file2) || sortByLastModified(file1, file2);
	});
};

function sortByPrefixedFilename(file1, file2) {
	var file1Filename = path.basename(file1.path);
	var file2Filename = path.basename(file2.path);
	var file1Prefix = parseInt(file1Filename);
	var file2Prefix = parseInt(file2Filename);
	var file1HasPrefix = !isNaN(file1Prefix);
	var file2HasPrefix = !isNaN(file2Prefix);
	if (!file1HasPrefix && !file2HasPrefix) { return 0; }
	if (file1HasPrefix && !file2HasPrefix) { return -1; }
	if (file2HasPrefix && !file1HasPrefix) { return 1; }
	if (file1Prefix === file2Prefix) {
		return sortByFilename(file1, file2);
	}
	return file1Prefix - file2Prefix;
}

function sortByFilename(file1, file2) {
	var file1Filename = path.basename(file1.path);
	var file2Filename = path.basename(file2.path);
	return (file1Filename.toLowerCase() < file2Filename.toLowerCase() ? -1 : 1);
}

function sortByLastModified(file1, file2) {
	var file1Date = new Date(file1.modified);
	var file2Date = new Date(file2.modified);
	return file2Date.getTime() - file1Date.getTime();
}

function stripLeadingNumber(string) {
	return string.replace(/^[0-9]+[ \.\-\|]*/, '');
}