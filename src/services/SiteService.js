'use strict';

var assert = require('assert');
var path = require('path');
var objectAssign = require('object-assign');
var isTextOrBinary = require('istextorbinary');
var template = require('es6-template-strings');
var isEqual = require('lodash.isequal');

var parseShortcutUrl = require('../utils/parseShortcutUrl');

var HttpError = require('../errors/HttpError');

var UserService = require('../services/UserService');
var MarkdownService = require('./MarkdownService');
var AuthenticationService = require('../services/AuthenticationService');

var constants = require('../constants');

var SECONDS = 1000;
var API_CACHE_EXPIRY_DURATION = 5 * SECONDS;
var DB_COLLECTION_SITES = constants.DB_COLLECTION_SITES;

function SiteService(database, options) {
	options = options || {};
	var host = options.host;
	var adapters = options.adapters;

	assert(database, 'Missing database');
	assert(host, 'Missing host details');
	assert(adapters, 'Missing adapters configuration');

	this.database = database;
	this.host = host;
	this.adapters = adapters;
}

SiteService.prototype.database = null;

SiteService.prototype.createSite = function(siteModel, siteTemplateFiles) {
	try {
		assert(siteModel, 'Missing site model');
	} catch (error) {
		return Promise.reject(error);
	}

	var database = this.database;
	var host = this.host;
	var adapters = this.adapters;
	var requireFullModel = true;
	return validateSiteModel(siteModel, requireFullModel)
		.then(function(siteModel) {
			var userService = new UserService(database);
			var username = siteModel.owner;
			return userService.retrieveUser(username)
				.catch(function(error) {
					if (error.status === 404) {
						throw new HttpError(400);
					}
				})
				.then(function(userModel) {
					return siteModel;
				});
		})
		.then(function(siteModel) {
			return createSite(database, siteModel)
				.catch(function(error) {
					if (error.code === database.ERROR_CODE_DUPLICATE_KEY) {
						throw new HttpError(409, 'A canvas already exists at that path');
					}
					throw error;
				});
		})
		.then(function() {
			if (!siteModel.root || !siteTemplateFiles) { return; }
			var username = siteModel.owner;
			var userService = new UserService(database);
			return userService.retrieveUser(username)
				.then(function(userModel) {
					var userAdapters = userModel.adapters;
					var context = {
						host: host,
						user: userModel,
						site: siteModel
					};
					return generateSiteFiles(siteTemplateFiles, context)
						.then(function(siteFiles) {
							var siteRoot = siteModel.root;
							var siteAdapterName = siteRoot.adapter;
							var siteAdapterConfig = siteRoot.config;
							var adapter = adapters[siteAdapterName];
							var userAdapterConfig = userAdapters[siteAdapterName];
							return adapter.initSiteFolder(siteFiles, siteAdapterConfig, userAdapterConfig);
						});
				});
		})
		.then(function() {
			return siteModel;
		});
};

SiteService.prototype.retrieveSite = function(username, siteName, options) {
	try {
		assert(username, 'Missing username');
		assert(siteName, 'Missing site name');
	} catch (error) {
		return Promise.reject(error);
	}

	options = options || {};
	var onlyPublishedSites = Boolean(options.published);
	var includeTheme = Boolean(options.theme);
	var includeContents = Boolean(options.contents);
	var includeUsers = Boolean(options.users);
	var cacheDuration = (typeof options.cacheDuration === 'number' ? options.cacheDuration : API_CACHE_EXPIRY_DURATION);
	var database = this.database;
	var adapters = this.adapters;
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
			var siteCache = siteModel.cache;
			var canUseCachedContents = Boolean(siteCache) && getIsCacheValid(siteCache.site, cacheDuration);
			if (canUseCachedContents) {
				siteModel.contents = siteCache.site.contents;
				return siteModel;
			}
			var userService = new UserService(database);
			return userService.retrieveUserAdapters(username)
				.then(function(userAdapters) {
					var siteRoot = siteModel.root;
					var siteAdapterName = siteRoot.adapter;
					var siteAdapterConfig = siteRoot.config;
					var adapter = adapters[siteAdapterName];
					var userAdapterConfig = objectAssign({}, userAdapters[siteAdapterName], {
						cache: siteCache && siteCache.adapter || null
					});
					return adapter.loadSiteContents(siteAdapterConfig, userAdapterConfig)
						.then(function(folder) {
							var siteCache = {
								site: {
									contents: folder.root,
									updated: new Date()
								},
								adapter: folder.cache
							};
							return updateSiteCache(database, username, siteName, siteCache)
								.then(function() {
									siteModel.cache = siteCache;
									siteModel.contents = siteCache.site.contents;
									return siteModel;
								});
						})
						.catch(function(error) {
							if (error.status === 401) {
								return siteModel;
							}
							throw error;
						});
				});
		});


	function getIsCacheValid(cache, cacheDuration) {
		if (!cache) { return false; }
		var lastCacheUpdateDate = cache.updated;
		var delta = (new Date() - lastCacheUpdateDate);
		return (delta <= cacheDuration);
	}
};

SiteService.prototype.updateSite = function(username, siteName, updates) {
	try {
		assert(username, 'Missing username');
		assert(siteName, 'Missing site name');
		assert(updates, 'Missing site updates');
	} catch (error) {
		return Promise.reject(error);
	}

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
		return retrieveSiteRoot(database, username, siteName)
			.then(function(existingSiteRoot) {
				if (!existingSiteRoot || !updates.root) {
					return existingSiteRoot !== updates.root;
				}
				var siteRootHasChanged = !isEqual(existingSiteRoot, updates.root);
				return siteRootHasChanged;
			});
	}
};

SiteService.prototype.deleteSite = function(username, siteName) {
	try {
		assert(username, 'Missing username');
		assert(siteName, 'Missing site name');
	} catch (error) {
		return Promise.reject(error);
	}

	var database = this.database;
	var userService = new UserService(database);
	return checkWhetherSiteisUserDefaultSite(username, siteName)
		.then(function(isDefaultSite) {
			return deleteSite(database, username, siteName)
				.then(function() {
					if (isDefaultSite) {
						return resetUserDefaultSite(username);
					}
				});
		});


	function checkWhetherSiteisUserDefaultSite(username, siteName) {
		return userService.retrieveUserDefaultSiteName(username)
			.then(function(defaultSiteName) {
				return siteName === defaultSiteName;
			});
	}

	function resetUserDefaultSite(username) {
		return userService.updateUserDefaultSiteName(username, null)
			.then(function(siteName) {
				return;
			});
	}
};

SiteService.prototype.retrieveSiteAuthenticationDetails = function(username, siteName, options) {
	try {
		assert(username, 'Missing username');
		assert(siteName, 'Missing site name');
	} catch (error) {
		return Promise.reject(error);
	}

	options = options || {};
	var onlyPublishedSites = Boolean(options.published);
	var database = this.database;
	return retrieveSiteAuthenticationDetails(database, username, siteName, onlyPublishedSites);
};

SiteService.prototype.retrieveSiteCache = function(username, siteName) {
	try {
		assert(username, 'Missing username');
		assert(siteName, 'Missing site name');
	} catch (error) {
		return Promise.reject(error);
	}

	var database = this.database;
	return retrieveSiteCache(database, username, siteName);
};

SiteService.prototype.updateSiteCache = function(username, siteName, cache) {
	try {
		assert(username, 'Missing username');
		assert(siteName, 'Missing site name');
	} catch (error) {
		return Promise.reject(error);
	}

	cache = cache || null;
	var database = this.database;
	return updateSiteCache(database, username, siteName, cache);
};

SiteService.prototype.retrieveSiteDownloadLink = function(username, siteName, filePath) {
	try {
		assert(username, 'Missing username');
		assert(siteName, 'Missing site name');
		assert(filePath, 'Missing file path');
	} catch (error) {
		return Promise.reject(error);
	}

	var database = this.database;
	var adapters = this.adapters;
	return retrieveSiteRoot(database, username, siteName)
		.then(function(siteRoot) {
			if (!siteRoot) { throw new HttpError(404); }
			var userService = new UserService(database);
			return userService.retrieveUserAdapters(username)
				.then(function(userAdapters) {
					var siteAdapterName = siteRoot.adapter;
					var siteAdapterConfig = siteRoot.config;
					var adapter = adapters[siteAdapterName];
					var userAdapterConfig = userAdapters[siteAdapterName];
					return adapter.retrieveDownloadLink(filePath, siteAdapterConfig, userAdapterConfig);
				});
		});
};

SiteService.prototype.retrieveSitePreviewLink = function(username, siteName, filePath) {
	try {
		assert(username, 'Missing username');
		assert(siteName, 'Missing site name');
		assert(filePath, 'Missing file path');
	} catch (error) {
		return Promise.reject(error);
	}

	var database = this.database;
	var adapters = this.adapters;
	return retrieveSiteRoot(database, username, siteName)
		.then(function(siteRoot) {
			if (!siteRoot) { throw new HttpError(404); }
			var userService = new UserService(database);
			return userService.retrieveUserAdapters(username)
				.then(function(userAdapters) {
					var siteAdapterName = siteRoot.adapter;
					var siteAdapterConfig = siteRoot.config;
					var adapter = adapters[siteAdapterName];
					var userAdapterConfig = userAdapters[siteAdapterName];
					return adapter.retrievePreviewLink(filePath, siteAdapterConfig, userAdapterConfig);
				});
		});
};

SiteService.prototype.retrieveSiteThumbnailLink = function(username, siteName, filePath) {
	try {
		assert(username, 'Missing username');
		assert(siteName, 'Missing site name');
		assert(filePath, 'Missing file path');
	} catch (error) {
		return Promise.reject(error);
	}

	var database = this.database;
	var adapters = this.adapters;
	return retrieveSiteRoot(database, username, siteName)
		.then(function(siteRoot) {
			if (!siteRoot) { throw new HttpError(404); }
			var userService = new UserService(database);
			return userService.retrieveUserAdapters(username)
				.then(function(userAdapters) {
					var siteAdapterName = siteRoot.adapter;
					var siteAdapterConfig = siteRoot.config;
					var adapter = adapters[siteAdapterName];
					var userAdapterConfig = userAdapters[siteAdapterName];
					return adapter.retrieveThumbnailLink(filePath, siteAdapterConfig, userAdapterConfig);
				});
		});
};

SiteService.prototype.retrieveSiteShortcutLink = function(username, siteName, filePath) {
	try {
		assert(username, 'Missing username');
		assert(siteName, 'Missing site name');
		assert(filePath, 'Missing file path');
		assert(['.webloc', '.url', '.desktop'].indexOf(path.extname(filePath)) !== -1, 'Invalid shortcut file');
	} catch (error) {
		return Promise.reject(error);
	}

	var database = this.database;
	var adapters = this.adapters;
	var fileExtension = path.extname(filePath);
	return retrieveSiteRoot(database, username, siteName)
		.then(function(siteRoot) {
			if (!siteRoot) { throw new HttpError(404); }
			var userService = new UserService(database);
			return userService.retrieveUserAdapters(username)
				.then(function(userAdapters) {
					var siteAdapterName = siteRoot.adapter;
					var siteAdapterConfig = siteRoot.config;
					var adapter = adapters[siteAdapterName];
					var userAdapterConfig = userAdapters[siteAdapterName];
					return adapter.readFile(filePath, siteAdapterConfig, userAdapterConfig);
				})
				.then(function(shortcutData) {
					var shortcutType = fileExtension.substr('.'.length);
					return parseShortcutUrl(shortcutData, { type: shortcutType });
				});
		});
};

SiteService.prototype.createSiteUser = function(username, siteName, authDetails, siteAuthOptions) {
	try {
		assert(username, 'Missing username');
		assert(siteName, 'Missing site name');
		assert(authDetails, 'Missing auth details');
		assert(authDetails.username, 'Missing auth username');
		assert(authDetails.password, 'Missing auth password');
		assert(siteAuthOptions, 'Missing site auth options');
	} catch (error) {
		return Promise.reject(error);
	}

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
	try {
		assert(username, 'Missing username');
		assert(siteName, 'Missing site name');
		assert(siteUsername, 'Missing site username');
		assert(authDetails, 'Missing auth details');
		assert(authDetails.username, 'Missing auth username');
		assert(authDetails.password, 'Missing auth password');
		assert(siteAuthOptions, 'Missing site auth options');
	} catch (error) {
		return Promise.reject(error);
	}

	var database = this.database;
	return updateSiteUser(database, username, siteName, siteUsername, authDetails, siteAuthOptions);
};


SiteService.prototype.deleteSiteUser = function(username, siteName, siteUsername) {
	try {
		assert(username, 'Missing username');
		assert(siteName, 'Missing site name');
		assert(siteUsername, 'Missing site username');
	} catch (error) {
		return Promise.reject(error);
	}

	var database = this.database;
	return deleteSiteUser(database, username, siteName, siteUsername);
};

SiteService.prototype.retrieveFileMetadata = function(username, adapterName, filePath) {
	try {
		assert(username, 'Missing username');
		assert(adapterName, 'Missing adapter name');
		assert(filePath, 'Missing file path');
	} catch (error) {
		return Promise.reject(error);
	}

	var database = this.database;
	var adapters = this.adapters;
	var userService = new UserService(database);
	return userService.retrieveUserAdapters(username)
		.then(function(userAdapters) {
			var adapter = adapters[adapterName];
			var userAdapterConfig = userAdapters[adapterName];
			return adapter.retrieveFileMetadata(filePath, userAdapterConfig);
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
			if (onlyPublishedSites && !siteModel.published) { throw new HttpError(404); }
			return siteModel;
		});
}

function updateSite(database, username, siteName, fields) {
	var filter = { 'owner': username, 'name': siteName };
	var updates = { $set: fields };
	return database.collection(DB_COLLECTION_SITES).updateOne(filter, updates)
		.then(function(numRecords) {
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
	var fields = [
		'private',
		'users'
	];
	if (onlyPublishedSites) { fields.push('published'); }
	return database.collection(DB_COLLECTION_SITES).findOne(query, fields)
		.then(function(siteModel) {
			if (!siteModel) { throw new HttpError(404); }
			if (onlyPublishedSites && !siteModel.published) { throw new HttpError(404); }
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
		.then(function(numRecords) {
			if (numRecords === 0) { throw new HttpError(404); }
			return;
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
	var authenticationService = new AuthenticationService();
	var authUsername = authDetails.username;
	var authPassword = authDetails.password;
	var authStrategy = siteAuthOptions.strategy;
	var authOptions = siteAuthOptions.options;
	return authenticationService.create(authUsername, authPassword, authStrategy, authOptions)
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
	var authenticationService = new AuthenticationService();
	var authUsername = authDetails.username;
	var authPassword = authDetails.password;
	var authStrategy = siteAuthOptions.strategy;
	var authOptions = siteAuthOptions.options;
	return authenticationService.create(authUsername, authPassword, authStrategy, authOptions)
		.then(function(siteUserModel) {
			var filter = { 'owner': username, 'name': siteName, 'users.username': siteUsername };
			var updates = { $set: { 'users.$': siteUserModel } };
			return database.collection(DB_COLLECTION_SITES).updateOne(filter, updates)
				.then(function(numRecords) {
					if (numRecords === 0) { throw new HttpError(404); }
					return;
				});
		});
}

function deleteSiteUser(database, username, siteName, siteUsername) {
	var filter = { 'owner': username, 'name': siteName };
	var updates = { $pull: { 'users': { 'username': siteUsername } } };
	return database.collection(DB_COLLECTION_SITES).updateOne(filter, updates)
		.then(function(numRecords) {
			if (numRecords === 0) { throw new HttpError(404); }
			return;
		});
}

function generateSiteFiles(siteTemplateFiles, context) {
	var flattenedTemplateFiles = flattenPathHierarchy(siteTemplateFiles);
	var expandedTemplateFiles = expandPlaceholders(flattenedTemplateFiles, context);
	return convertMarkdownFiles(expandedTemplateFiles);


	function flattenPathHierarchy(tree, pathPrefix) {
		pathPrefix = pathPrefix || '';
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

	function convertMarkdownFiles(files) {
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
			return Promise.resolve({
				path: replaceFileExtension(filePath, '.html'),
				data: new Buffer(html)
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

		function replaceFileExtension(filePath, extension) {
			return path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)) + extension);
		}
	}
}

function validateSiteModel(siteModel, requireFullModel) {
	return new Promise(function(resolve, reject) {
		if (!siteModel) { throw new HttpError(400, 'No site model specified'); }
		if ((requireFullModel || ('owner' in siteModel)) && !siteModel.owner) { throw new HttpError(400, 'No owner specified'); }
		if ((requireFullModel || ('name' in siteModel)) && !siteModel.name) { throw new HttpError(400, 'No site name specified'); }
		if ((requireFullModel || ('label' in siteModel)) && !siteModel.label) { throw new HttpError(400, 'No site label specified'); }
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
