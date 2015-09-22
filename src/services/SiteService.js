'use strict';

var mapSeries = require('promise-map-series');
var escapeRegExp = require('escape-regexp');
var path = require('path');
var objectAssign = require('object-assign');
var isTextOrBinary = require('istextorbinary');
var template = require('es6-template-strings');
var pdf = require('html-pdf');

var HttpError = require('../errors/HttpError');

var DropboxService = require('../services/DropboxService');
var UserService = require('../services/UserService');
var MarkdownService = require('./MarkdownService');
var AuthenticationService = require('../services/AuthenticationService');

var constants = require('../constants');

var SECONDS = 1000;
var DROPBOX_CACHE_EXPIRY_DURATION = 5 * SECONDS;
var DB_COLLECTION_SITES = constants.DB_COLLECTION_SITES;
var SITE_TEMPLATE_FILES = constants.SITE_TEMPLATE_FILES;

var PROVIDER_ID_DROPBOX = 'dropbox';

function SiteService(database, options) {
	options = options || {};
	var host = options.host;
	var providers = options.providers;

	this.database = database;
	this.host = host;
	this.providers = providers;
}

SiteService.prototype.database = null;

SiteService.prototype.createSite = function(siteModel) {
	if (!siteModel) { return Promise.reject(new HttpError(400, 'No site model specified')); }
	var database = this.database;
	var host = this.host;
	var providers = this.providers;
	var requireFullModel = true;
	return validateSiteModel(siteModel, requireFullModel)
		.then(function(siteModel) {
			return createSite(database, siteModel)
				.catch(function(error) {
					if (error.code === database.ERROR_CODE_DUPLICATE_KEY) {
						throw new HttpError(409, 'A site already exists at that path');
					}
					throw error;
				});
		})
		.then(function() {
			if (!siteModel.root) { return; }
			var username = siteModel.owner;
			return retrieveUser(database, username)
				.then(function(userModel) {
					var userProviders = userModel.providers;
					var siteRoot = siteModel.root;
					var sitePath = siteRoot.path;
					var context = {
						host: host,
						user: userModel,
						site: siteModel
					};
					return generateSiteFiles(sitePath, context)
						.then(function(siteFiles) {
							return initSiteFolder(siteModel, siteFiles, userProviders);
						});


						function initSiteFolder(siteModel, siteFiles, userProviders) {
							var siteRoot = siteModel.root;
							var siteProvider = siteRoot.provider;
							switch (siteProvider) {
								case PROVIDER_ID_DROPBOX:
									var appKey = providers.dropbox.appKey;
									var appSecret = providers.dropbox.appSecret;
									var uid = userProviders.dropbox.uid;
									var accessToken = userProviders.dropbox.token;
									return initDropboxSiteFolder(appKey, appSecret, uid, accessToken, sitePath, siteFiles);
								default:
									throw new Error('Invalid provider: ' + siteProvider);
							}
						}
				});
		})
		.then(function() {
			return siteModel;
		});
};

SiteService.prototype.retrieveSite = function(username, siteName, options) {
	if (!username) { return Promise.reject(new HttpError(400, 'No username specified')); }
	if (!siteName) { return Promise.reject(new HttpError(400, 'No site specified')); }
	options = options || {};
	var onlyPublishedSites = Boolean(options.published);
	var includeTheme = Boolean(options.theme);
	var includeContents = Boolean(options.contents);
	var includeUsers = Boolean(options.users);
	var cacheDuration = (typeof options.cacheDuration === 'number' ? options.cacheDuration : DROPBOX_CACHE_EXPIRY_DURATION);
	var database = this.database;
	var providers = this.providers;
	return retrieveSite(database, username, siteName, {
		published: onlyPublishedSites,
		theme: includeTheme,
		contents: includeContents,
		users: includeUsers
	})
		.then(function(siteModel) {
			if (!includeContents) { return siteModel; }
			var hasSiteFolder = (siteModel.root !== null);
			if (!hasSiteFolder) { return null; }
			var siteRoot = siteModel.root;
			var sitePath = siteRoot.path;
			var siteCache = siteModel.cache;
			var canUseCachedContents = getIsCacheValid(siteCache, cacheDuration);
			if (canUseCachedContents) {
				siteModel.contents = parseFileModel(siteCache.contents, sitePath);
				return siteModel;
			}
			return retrieveUserProviders(database, username)
				.then(function(userProviders) {
					return loadFolderContents(siteModel, userProviders)
						.then(function(folderCache) {
							return updateSiteCache(database, username, siteName, folderCache)
								.then(function() {
									siteModel.cache = folderCache;
									siteModel.contents = parseFileModel(folderCache.contents, sitePath);
									return siteModel;
								});
						});


						function loadFolderContents(siteModel, userProviders) {
							var siteRoot = siteModel.root;
							var siteProvider = siteRoot.provider;
							var sitePath = siteRoot.path;
							var siteCache = siteModel.cache;

							switch (siteProvider) {
								case PROVIDER_ID_DROPBOX:
									var appKey = providers.dropbox.appKey;
									var appSecret = providers.dropbox.appSecret;
									var uid = userProviders.dropbox.uid;
									var accessToken = userProviders.dropbox.token;
									return loadDropoxFolderContents(appKey, appSecret, uid, accessToken, sitePath, siteCache)
										.then(function(dropboxContents) {
											return {
												contents: dropboxContents.contents,
												data: dropboxContents.data,
												cursor: dropboxContents.cursor,
												updated: new Date()
											};
										});
								default:
									throw new Error('Invalid provider: ' + siteProvider);
							}
						}
				});
		});


	function getIsCacheValid(cache, cacheDuration) {
		if (!cache) { return false; }
		var lastCacheUpdateDate = cache.updated;
		var delta = (new Date() - lastCacheUpdateDate);
		return (delta <= cacheDuration);
	}

	function parseFileModel(file, rootFolderPath) {
		if (!file) { return null; }

		file.url = getFileUrl(file.path, rootFolderPath);

		if (file.is_dir) {
			file.contents = file.contents.map(function(file) {
				return parseFileModel(file, rootFolderPath);
			});
		}

		Object.defineProperty(file, 'folders', {
			'get': function() {
				if (!this.contents) { return null; }
				var folders = this.contents.filter(function(fileModel) {
					return fileModel.is_dir;
				});
				var sortedFolders = folders.sort(function(file1, file2) {
					return sortByPrefixedFilename(file1, file2) || sortByFilename(file1, file2);
				});
				return sortedFolders;
			}
		});

		Object.defineProperty(file, 'files', {
			'get': function() {
				if (!this.contents) { return null; }
				var files = this.contents.filter(function(fileModel) {
					return !fileModel.is_dir;
				});
				var sortedFiles = files.sort(function(file1, file2) {
					return sortByPrefixedFilename(file1, file2) || sortByLastModified(file1, file2);
				});
				return sortedFiles;
			}
		});

		return file;


		function getFileUrl(path, rootFolderPath) {
			var rootFolderRegExp = new RegExp('^' + escapeRegExp(rootFolderPath), 'i');
			var isExternalPath = path.toLowerCase().indexOf(rootFolderPath.toLowerCase()) !== 0;
			if (isExternalPath) { throw new Error('Invalid file path: "' + path + '"'); }
			return path.replace(rootFolderRegExp, '').split('/').map(encodeURIComponent).join('/');
		}

		function sortByPrefixedFilename(file1, file2) {
			var file1Filename = file1.name;
			var file2Filename = file2.name;
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
			return (file1.name.toLowerCase() < file2.name.toLowerCase() ? -1 : 1);
		}

		function sortByLastModified(file1, file2) {
			return (file2.timestamp - file1.timestamp);
		}
	}
};

SiteService.prototype.updateSite = function(username, siteName, updates) {
	if (!username) { return Promise.reject(new HttpError(400, 'No username specified')); }
	if (!siteName) { return Promise.reject(new HttpError(400, 'No site specified')); }
	if (!updates) { return Promise.reject(new HttpError(400, 'No updates specified')); }
	var database = this.database;
	var requireFullModel = false;
	return validateSiteModel(updates, requireFullModel)
		.then(function(updates) {
			return checkWhetherIsChangingSiteRoot(username, siteName, updates)
				.then(function(isChangingSiteRoot) {
					if (isChangingSiteRoot) {
						updates.cache = null;
					}
					return updateSite(database, username, siteName, updates);
				});
		});


	function checkWhetherIsChangingSiteRoot(username, siteName, updates) {
		var isUpdatingSiteRoot = 'root' in updates;
		if (!isUpdatingSiteRoot) { return Promise.resolve(false); }
		return getSiteRoot(database, username, siteName)
			.then(function(existingSiteRoot) {
				var siteRootHasChanged =
					(existingSiteRoot.provider !== updates.root.provider) ||
					(existingSiteRoot.path !== updates.root.path);
				return siteRootHasChanged;
			});
	}
};

SiteService.prototype.deleteSite = function(username, siteName) {
	if (!username) { return Promise.reject(new HttpError(400, 'No username specified')); }
	if (!siteName) { return Promise.reject(new HttpError(400, 'No site specified')); }
	var database = this.database;
	return checkWhetherSiteisUserDefaultSite(database, username, siteName)
		.then(function(isDefaultSite) {
			return deleteSite(database, username, siteName)
				.then(function() {
					if (isDefaultSite) {
						return resetUserDefaultSite(database, username);
					}
				});
		});
};

SiteService.prototype.retrieveSiteAuthenticationDetails = function(username, siteName, options) {
	if (!username) { return Promise.reject(new HttpError(400, 'No username specified')); }
	if (!siteName) { return Promise.reject(new HttpError(400, 'No site specified')); }
	options = options || {};
	var onlyPublishedSites = Boolean(options.published);
	var database = this.database;
	return retrieveSiteAuthenticationDetails(database, username, siteName, onlyPublishedSites);
};

SiteService.prototype.retrieveSiteCache = function(username, siteName) {
	if (!username) { return Promise.reject(new HttpError(400, 'No username specified')); }
	if (!siteName) { return Promise.reject(new HttpError(400, 'No site specified')); }
	var database = this.database;
	return retrieveSiteCache(database, username, siteName);
};

SiteService.prototype.updateSiteCache = function(username, siteName, cache) {
	if (!username) { return Promise.reject(new HttpError(400, 'No username specified')); }
	if (!siteName) { return Promise.reject(new HttpError(400, 'No site specified')); }
	cache = cache || null;
	var database = this.database;
	return updateSiteCache(database, username, siteName, cache);
};

SiteService.prototype.retrieveSiteDownloadLink = function(username, siteName, filePath) {
	if (!username) { return Promise.reject(new HttpError(400, 'No username specified')); }
	if (!siteName) { return Promise.reject(new HttpError(400, 'No site specified')); }
	if (!filePath) { return Promise.reject(new HttpError(400, 'No file path specified')); }
	var database = this.database;
	var providers = this.providers;
	return retrieveSiteRoot(database, username, siteName)
		.then(function(siteRoot) {
			return retrieveUserProviders(database, username)
				.then(function(userProviders) {
					return retrieveDownloadLink(siteRoot, userProviders);


					function retrieveDownloadLink(siteRoot, userProviders) {
						var siteProvider = siteRoot.provider;
						var sitePath = siteRoot.path;
						switch (siteProvider) {
							case PROVIDER_ID_DROPBOX:
								var appKey = providers.dropbox.appKey;
								var appSecret = providers.dropbox.appSecret;
								var uid = userProviders.dropbox.uid;
								var accessToken = userProviders.dropbox.token;
								var dropboxFilePath = sitePath + '/' + filePath;
								return retrieveDropboxDownloadLink(appKey, appSecret, uid, accessToken, dropboxFilePath);
							default:
								throw new Error('Invalid provider: ' + siteProvider);
						}
					}
				});
		});
};

SiteService.prototype.retrieveSiteThumbnailLink = function(username, siteName, filePath) {
	if (!username) { return Promise.reject(new HttpError(400, 'No username specified')); }
	if (!siteName) { return Promise.reject(new HttpError(400, 'No site specified')); }
	if (!filePath) { return Promise.reject(new HttpError(400, 'No file path specified')); }
	var database = this.database;
	var providers = this.providers;
	return retrieveSiteRoot(database, username, siteName)
		.then(function(siteRoot) {
			return retrieveUserProviders(database, username)
				.then(function(userProviders) {
					return retrieveThumbnailLink(siteRoot, userProviders);


					function retrieveThumbnailLink(siteRoot, userProviders) {
						var siteProvider = siteRoot.provider;
						var sitePath = siteRoot.path;
						switch (siteProvider) {
							case PROVIDER_ID_DROPBOX:
								var appKey = providers.dropbox.appKey;
								var appSecret = providers.dropbox.appSecret;
								var uid = userProviders.dropbox.uid;
								var accessToken = userProviders.dropbox.token;
								var dropboxFilePath = sitePath + '/' + filePath;
								return retrieveDropboxThumbnailLink(appKey, appSecret, uid, accessToken, dropboxFilePath);
							default:
								throw new Error('Invalid provider: ' + siteProvider);
						}
					}
				});
		});
};

SiteService.prototype.createSiteUser = function(username, siteName, authDetails, siteAuthOptions) {
	if (!username) { return Promise.reject(new HttpError(400, 'No username specified')); }
	if (!siteName) { return Promise.reject(new HttpError(400, 'No site specified')); }
	if (!authDetails) { return Promise.reject(new HttpError(400, 'No auth details specified')); }
	if (!authDetails.username) { return Promise.reject(new HttpError(400, 'No auth username specified')); }
	if (!authDetails.password) { return Promise.reject(new HttpError(400, 'No auth password specified')); }
	var database = this.database;
	return checkWhetherSiteUserAlreadyExists(database, username, siteName, authDetails.username)
		.then(function(userAlreadyExists) {
			if (userAlreadyExists) {
				throw new HttpError(409, 'A user already exists with this username');
			}
			return createSiteUser(database, username, siteName, authDetails, siteAuthOptions);
		});
};

SiteService.prototype.updateSiteUser = function(username, siteName, siteUsername, authDetails, siteAuthOptions) {
	if (!username) { return Promise.reject(new HttpError(400, 'No username specified')); }
	if (!siteName) { return Promise.reject(new HttpError(400, 'No site specified')); }
	if (!siteUsername) { return Promise.reject(new HttpError(400, 'No user specified')); }
	if (!authDetails) { return Promise.reject(new HttpError(400, 'No auth details specified')); }
	if (!authDetails.username) { return Promise.reject(new HttpError(400, 'No auth username specified')); }
	if (!authDetails.password) { return Promise.reject(new HttpError(400, 'No auth password specified')); }
	var database = this.database;
	return updateSiteUser(database, username, siteName, siteUsername, authDetails, siteAuthOptions);
};


SiteService.prototype.deleteSiteUser = function(username, siteName, siteUsername) {
	if (!username) { return Promise.reject(new HttpError(400, 'No username specified')); }
	if (!siteName) { return Promise.reject(new HttpError(400, 'No site specified')); }
	if (!siteUsername) { return Promise.reject(new HttpError(400, 'No user specified')); }
	var database = this.database;
	return deleteSiteUser(database, username, siteName, siteUsername);
};

SiteService.prototype.getFileMetadata = function(username, provider, filePath) {
	if (!username) { return Promise.reject(new HttpError(400, 'No username specified')); }
	if (!provider) { return Promise.reject(new HttpError(400, 'No provider specified')); }
	if (!filePath) { return Promise.reject(new HttpError(400, 'No file path specified')); }
	var database = this.database;
	var providers = this.providers;
	return retrieveUserProviders(database, username)
		.then(function(userProviders) {
			return retrieveFileMetadata(provider, userProviders, filePath);


			function retrieveFileMetadata(provider, userProviders, filePath) {
				switch (provider) {
					case PROVIDER_ID_DROPBOX:
						var appKey = providers.dropbox.appKey;
						var appSecret = providers.dropbox.appSecret;
						var uid = userProviders.dropbox.uid;
						var accessToken = userProviders.dropbox.token;
						return getDropboxFileMetadata(appKey, appSecret, uid, accessToken, filePath);
					default:
						throw new Error('Invalid provider: ' + provider);
				}
			}
		});
};


function createSite(database, siteModel) {
	return database.collection(DB_COLLECTION_SITES).insertOne(siteModel);
}

function retrieveSite(database, username, siteName, options) {
	options = options || {};
	var onlyPublishedSites = Boolean(options.published);
	var includeTheme = Boolean(options.theme);
	var includeContents = Boolean(options.contents);
	var includeUsers = Boolean(options.users);

	var query = { 'owner': username, 'name': siteName };
	if (onlyPublishedSites) { query['published'] = true; }
	var fields = [
		'owner',
		'name',
		'label',
		'root',
		'private',
		'published'
	];
	if (includeTheme) { fields.push('theme'); }
	if (includeUsers) { fields.push('users'); }
	if (includeContents) { fields.push('cache'); }
	return database.collection(DB_COLLECTION_SITES).findOne(query, fields)
		.then(function(siteModel) {
			if (!siteModel) { throw new HttpError(404); }
			return siteModel;
		});
}

function updateSite(database, username, siteName, fields) {
	var filter = { 'owner': username, 'name': siteName };
	var updates = { $set: fields };
	return database.collection(DB_COLLECTION_SITES).updateOne(filter, updates)
		.then(function(error, numRecords) {
			if (numRecords === 0) { throw new HttpError(404); }
			return;
		});
}

function deleteSite(database, username, siteName) {
	var filter = { 'owner': username, 'name': siteName };
	return database.collection(DB_COLLECTION_SITES).deleteOne(filter)
		.then(function(numRecords) {
			if (numRecords === 0) { throw new HttpError(404); }
			return;
		});
}

function retrieveSiteAuthenticationDetails(database, username, siteName, onlyPublishedSites) {
	var query = { 'owner': username, 'name': siteName };
	if (onlyPublishedSites) { query['published'] = true; }
	var fields = [
		'private',
		'users'
	];
	return database.collection(DB_COLLECTION_SITES).findOne(query, fields)
		.then(function(siteModel) {
			if (!siteModel) { throw new HttpError(404); }
			var authenticationDetails = {
				'private': siteModel.private,
				'users': siteModel.users
			};
			return authenticationDetails;
		});
}

function retrieveSiteRoot(database, username, siteName) {
	var query = { 'owner': username, 'name': siteName };
	var fields = [
		'root'
	];
	return database.collection(DB_COLLECTION_SITES).findOne(query, fields)
		.then(function(siteModel) {
			if (!siteModel) { throw new HttpError(404); }
			if (!siteModel.root) { throw new HttpError(404); }
			var siteRoot = siteModel.root;
			return siteRoot;
		});
}

function retrieveSiteCache(database, username, siteName) {
	var query = { 'owner': username, 'name': siteName };
	var fields = [
		'cache'
	];
	return database.collection(DB_COLLECTION_SITES).findOne(query, fields)
		.then(function(siteModel) {
			if (!siteModel) { throw new HttpError(404); }
			var siteCache = siteModel.cache;
			return siteCache;
		});
}

function updateSiteCache(database, username, siteName, cache) {
	var filter = { 'owner': username, 'name': siteName };
	var updates = { $set: { 'cache': cache } };
	return database.collection(DB_COLLECTION_SITES).updateOne(filter, updates)
		.then(function(error, numRecords) {
			if (numRecords === 0) { throw new HttpError(404); }
			return;
		});
}

function checkWhetherSiteisUserDefaultSite(database, username, siteName) {
	var userService = new UserService(database);
	return userService.retrieveUserDefaultSiteName(username)
		.then(function(defaultSiteName) {
			return siteName === defaultSiteName;
		});
}

function resetUserDefaultSite(database, username) {
	var userService = new UserService(database);
	return userService.updateUserDefaultSiteName(username, null)
		.then(function(siteName) {
			return;
		});
}

function loadDropoxFolderContents(appKey, appSecret, uid, accessToken, folderPath, folderCache) {
	return new DropboxService().connect(appKey, appSecret, accessToken, uid)
		.then(function(dropboxClient) {
			return dropboxClient.loadFolderContents(folderPath, folderCache);
		});
}

function getSiteRoot(database, username, siteName) {
	var query = { 'owner': username, 'name': siteName };
	var fields = [
		'root'
	];
	return database.collection(DB_COLLECTION_SITES).findOne(query, fields)
		.then(function(siteModel) {
			if (!siteModel) { throw new HttpError(404); }
			var siteRoot = siteModel.root;
			return siteRoot;
		});
}

function checkWhetherSiteUserAlreadyExists(database, username, siteName, siteUsername) {
	var query = { 'owner': username, 'name': siteName, 'users.username': siteUsername };
	return database.collection(DB_COLLECTION_SITES).count(query)
		.then(function(numRecords) {
			var userAlreadyExists = (numRecords > 0);
			return userAlreadyExists;
		});
}

function createSiteUser(database, username, siteName, authDetails, siteAuthOptions) {
	var authenticationService = new AuthenticationService(siteAuthOptions);
	return authenticationService.create(authDetails.username, authDetails.password)
		.then(function(siteUserModel) {
			var filter = { 'owner': username, 'name': siteName };
			var updates = { $push: { 'users': siteUserModel } };
			return database.collection(DB_COLLECTION_SITES).updateOne(filter, updates)
				.then(function(numRecords) {
					if (numRecords === 0) {
						throw new HttpError(404);
					}
					return siteUserModel;
				});
		});
}

function updateSiteUser(database, username, siteName, siteUsername, authDetails, siteAuthOptions) {
	var authenticationService = new AuthenticationService(siteAuthOptions);
	return authenticationService.create(authDetails.username, authDetails.password)
		.then(function(siteUserModel) {
			var filter = { 'owner': username, 'name': siteName, 'users.username': siteUsername };
			var updates = { $set: { 'users.$': siteUserModel } };
			return database.collection(DB_COLLECTION_SITES).updateOne(filter, updates)
				.then(function(error, numRecords) {
					if (numRecords === 0) { throw new HttpError(404); }
					return;
				});
		});
}

function deleteSiteUser(database, username, siteName, siteUsername) {
	var filter = { 'owner': username, 'name': siteName };
	var updates = { $pull: { 'users': { 'username': siteUsername } } };
	return database.collection(DB_COLLECTION_SITES).updateOne(filter, updates)
		.then(function(error, numRecords) {
			if (numRecords === 0) { throw new HttpError(404); }
			return;
		});
}

function retrieveUser(database, username) {
	return new UserService(database).retrieveUser(username);
}

function retrieveUserProviders(database, username) {
	return new UserService(database).retrieveUserProviders(username);
}

function generateSiteFiles(pathPrefix, context) {
	var templateFiles = SITE_TEMPLATE_FILES;
	var flattenedTemplateFiles = flattenPathHierarchy(templateFiles, pathPrefix);
	var expandedTemplateFiles = expandPlaceholders(flattenedTemplateFiles, context);
	return convertMarkdownFiles(expandedTemplateFiles, { pdf: false });


	function flattenPathHierarchy(tree, pathPrefix) {
		var flattenedFiles = Object.keys(tree).reduce(function(flattenedFiles, filename) {
			var filePath = path.join(pathPrefix, filename);
			var fileObject = tree[filename];
			var isFile = Buffer.isBuffer(fileObject) || fileObject instanceof String;
			if (isFile) {
				flattenedFiles[filePath] = fileObject;
			} else {
				var childPaths = flattenPathHierarchy(fileObject, filePath);
				objectAssign(flattenedFiles, childPaths);
			}
			return flattenedFiles;
		}, {});
		return flattenedFiles;
	}

	function expandPlaceholders(files, context) {
		var expandedFiles = Object.keys(files).reduce(function(expandedFiles, filePath) {
			var filename = path.basename(filePath);
			var fileBuffer = files[filePath];
			var expandedFileBuffer = expandFilePlaceholders(filename, fileBuffer, context);
			expandedFiles[filePath] = expandedFileBuffer;
			return expandedFiles;
		}, {});
		return expandedFiles;


		function expandFilePlaceholders(filename, fileBuffer, context) {
			var isTextFile = getIsTextFile(filename, fileBuffer);
			if (!isTextFile) { return fileBuffer; }
			var templateString = fileBuffer.toString();
			var output = expandPlaceholderStrings(templateString, context);
			return new Buffer(output);


			function getIsTextFile(filePath, fileBuffer) {
				return isTextOrBinary.isTextSync(filePath, fileBuffer);
			}

			function expandPlaceholderStrings(source, context) {
				return template(source, context);
			}
		}
	}

	function convertMarkdownFiles(files, options) {
		options = options || {};
		var shouldCreatePdf = Boolean(options.pdf);

		var filePaths = Object.keys(files);
		return Promise.all(filePaths.map(function(filePath) {
			var filename = path.basename(filePath);
			var fileBuffer = files[filePath];
			var isMarkdownFile = getIsMarkdownFile(filename, fileBuffer);
			if (!isMarkdownFile) {
				return Promise.resolve({
					path: filePath,
					data: fileBuffer
				});
			}
			var markdownString = fileBuffer.toString();
			var html = new MarkdownService().renderHtml(markdownString);
			if (!shouldCreatePdf) {
				return Promise.resolve({
					path: replaceFileExtension(filePath, '.html'),
					data: new Buffer(html)
				});
			}
			return convertHtmlToPdf(html)
				.then(function(pdfBuffer) {
					return {
						path: replaceFileExtension(filePath, '.pdf'),
						data: pdfBuffer
					};
				});
		})).then(function(files) {
			var convertedFiles = files.reduce(function(convertedFiles, fileInfo) {
				var filePath = fileInfo.path;
				var fileBuffer = fileInfo.data;
				convertedFiles[filePath] = fileBuffer;
				return convertedFiles;
			}, {});
			return convertedFiles;
		});

		function getIsMarkdownFile(filename, file) {
			return (path.extname(filename) === '.md');
		}

		function convertHtmlToPdf(html) {
			return new Promise(function(resolve, reject) {
				pdf.create(html).toBuffer(function(error, buffer) {
					resolve(buffer);
				});
			});
		}

		function replaceFileExtension(filePath, extension) {
			return path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)) + extension);
		}
	}
}

function initDropboxSiteFolder(appKey, appSecret, uid, accessToken, sitePath, siteFiles) {
	return new DropboxService().connect(appKey, appSecret, accessToken, uid)
		.then(function(dropboxClient) {
			return checkWhetherFileExists(dropboxClient, sitePath)
				.then(function(folderExists) {
					if (folderExists) { return; }
					return copySiteFiles(dropboxClient, siteFiles);
				});
		});

	function checkWhetherFileExists(dropboxClient, filePath) {
		return dropboxClient.getFileMetadata(filePath)
			.then(function(stat) {
				if (stat.isRemoved) { return false; }
				return true;
			})
			.catch(function(error) {
				if (error.status === 404) {
					return false;
				}
				throw error;
			});
	}

	function copySiteFiles(dropboxClient, dirContents) {
		var files = getFileListing(dirContents);
		var writeOptions = {};
		return Promise.resolve(mapSeries(files, function(fileMetaData) {
			var filePath = fileMetaData.path;
			var fileContents = fileMetaData.contents;
			return dropboxClient.writeFile(filePath, fileContents, writeOptions);
		}).then(function(results) {
			return;
		}));


		function getFileListing(dirContents) {
			var files = Object.keys(dirContents)
				.sort(function(filePath1, filePath2) {
					return (filePath1 < filePath2 ? -1 : 1);
				})
				.map(function(filePath) {
					var file = dirContents[filePath];
					return {
						path: filePath,
						contents: file
					};
				});
			return files;
		}
	}
}

function retrieveDropboxDownloadLink(appKey, appSecret, uid, accessToken, filePath) {
	return new DropboxService().connect(appKey, appSecret, accessToken, uid)
		.then(function(dropboxClient) {
			return dropboxClient.generateDownloadLink(filePath);
		});
}

function retrieveDropboxThumbnailLink(appKey, appSecret, uid, accessToken, filePath) {
	return new DropboxService().connect(appKey, appSecret, accessToken, uid)
		.then(function(dropboxClient) {
			return dropboxClient.generateThumbnailLink(filePath);
		});
}

function getDropboxFileMetadata(appKey, appSecret, uid, accessToken, filePath) {
	return new DropboxService().connect(appKey, appSecret, accessToken, uid)
		.then(function(dropboxClient) {
			return dropboxClient.getFileMetadata(filePath)
				.then(function(stat) {
					return stat.json();
				});
		});
}

function validateSiteModel(siteModel, requireFullModel) {
	return new Promise(function(resolve, reject) {
		if (!siteModel) { throw new HttpError(400, 'No site model specified'); }
		if ((requireFullModel || ('owner' in siteModel)) && !siteModel.owner) { throw new HttpError(400, 'No owner specified'); }
		if ((requireFullModel || ('name' in siteModel)) && !siteModel.name) { throw new HttpError(400, 'No site path specified'); }
		if ((requireFullModel || ('label' in siteModel)) && !siteModel.label) { throw new HttpError(400, 'No site name specified'); }
		if ((requireFullModel || ('theme' in siteModel)) && !siteModel.theme) { throw new HttpError(400, 'No site theme specified'); }

		// TODO: Validate owner when validating site model
		// TODO: Validate name when validating site model
		// TODO: Validate label when validating site model
		// TODO: Validate theme when validating site model
		// TODO: Validate root when validating site model
		// TODO: Validate home option when validating site model

		resolve(siteModel);
	});
}

module.exports = SiteService;
