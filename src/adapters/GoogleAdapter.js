'use strict';

var util = require('util');
var path = require('path');
var url = require('url');
var objectAssign = require('object-assign');
var isEqual = require('lodash.isequal');
var request = require('request');
var express = require('express');
var mime = require('mime');
var mapSeries = require('promise-map-series');
var escapeRegExp = require('escape-regexp');
var slug = require('slug');
var GoogleOAuth2Strategy = require('passport-google-oauth2').Strategy;

var LoginAdapter = require('./LoginAdapter');
var StorageAdapter = require('./StorageAdapter');

var appendQueryParams = require('../utils/appendQueryParams');

var UserService = require('../services/UserService');
var RedirectService = require('../services/RedirectService');

var FileModel = require('../models/FileModel');

var HttpError = require('../errors/HttpError');

// Autogenerated download link expiry time, in seconds
var DOWNLOAD_LINK_DURATION = 60 * 60;

// If there is less than this number of seconds remaining
// on the current access token, request a refreshed token
var MIN_TOKEN_VALIDITY_DURATION = 30;

var THUMBNAIL_SIZE = 360;

var OAUTH2_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
var OAUTH2_TOKEN_URL = 'https://www.googleapis.com/oauth2/v4/token';

var MAX_API_RESULTS = 1000;
var MIME_TYPE_FOLDER = 'application/vnd.google-apps.folder';

GoogleOAuth2Strategy.prototype.userProfile = function(token, callback) {
	return loadCurrentUserProfile({ accessToken: token })
		.then(function(profile) {
			callback(null, profile);
		})
		.catch(function(error) {
			callback(error);
		});


	function loadCurrentUserProfile(options) {
		options = options || {};
		var accessToken = options.accessToken;
		return apiRequest({
			token: accessToken,
			method: 'GET',
			url: 'https://www.googleapis.com/oauth2/v2/userinfo'
		}).then(function(data) {
			var profile = {
				uid: data['id'],
				firstName: data['given_name'],
				lastName: data['family_name'],
				email: data['email']
			};
			return profile;
		});
	}
};

function GoogleLoginAdapter(database, options) {
	options = options || {};
	var isTemporary = options.temporary || null;
	var clientId = options.clientId;
	var clientSecret = options.clientSecret;
	var authOptions = options.authOptions;
	var loginCallbackUrl = options.loginCallbackUrl;

	if (!clientId) { throw new Error('Missing Google app key'); }
	if (!clientSecret) { throw new Error('Missing Google app secret'); }
	if (!authOptions || !authOptions.scope) { throw new Error('Missing Google auth scope'); }
	if (!loginCallbackUrl) { throw new Error('Missing login callback URL'); }

	LoginAdapter.call(this, database, {
		temporary: isTemporary
	});

	this.clientId = clientId;
	this.clientSecret = clientSecret;
	this.loginCallbackUrl = loginCallbackUrl;
	this.authOptions = authOptions;

	LoginAdapter.call(this, database, {
		temporary: isTemporary
	});
}

util.inherits(GoogleLoginAdapter, LoginAdapter);

GoogleLoginAdapter.prototype.adapterName = 'google';
GoogleLoginAdapter.prototype.clientKey = null;
GoogleLoginAdapter.prototype.clientSecret = null;
GoogleLoginAdapter.prototype.loginCallbackUrl = null;

GoogleLoginAdapter.prototype.middleware = function(passport, callback) {
	var clientId = this.clientId;
	var clientSecret = this.clientSecret;
	var loginCallbackUrl = this.loginCallbackUrl;
	var authOptions = this.authOptions;

	var app = express();

	app.post('/', passport.authenticate('admin/google', authOptions));
	app.get('/oauth2/callback', function(req, res, next) {
		passport.authenticate('admin/google', function(error, user, info) {
			callback(error, user, info, req, res, next);
		})(req, res, next);
	});

	var self = this;
	passport.use('admin/google', new GoogleOAuth2Strategy({
			clientID: clientId,
			clientSecret: clientSecret,
			callbackURL: loginCallbackUrl,
			passReqToCallback: true,
			authorizationURL: OAUTH2_AUTHORIZATION_URL,
			tokenURL: OAUTH2_TOKEN_URL
		},
		function(req, accessToken, refreshToken, params, profile, callback) {
			var tokenDuration = params['expires_in'];
			var tokenExpires = getTokenExpiryDate(tokenDuration).toISOString();
			var passportValues = {
				uid: profile.uid,
				token: accessToken,
				tokenExpires: tokenExpires,
				refreshToken: refreshToken || null,
				firstName: profile.firstName,
				lastName: profile.lastName,
				email: profile.email
			};
			var query = { 'uid': passportValues.uid };
			self.login(req, query, passportValues, callback);
		}
	));

	return app;
};

GoogleLoginAdapter.prototype.authenticate = function(passportValues, userAdapterConfig) {
	return Promise.resolve(true);
};

GoogleLoginAdapter.prototype.getUserDetails = function(passportValues) {
	var firstName = passportValues.firstName;
	var lastName = passportValues.lastName;
	var email = passportValues.email;
	var fullName = firstName + ' ' + lastName;
	var username = slug(fullName, { lower: true });
	var userDetails = {
		username: username,
		firstName: firstName,
		lastName: lastName,
		email: email
	};
	return Promise.resolve(userDetails);
};

GoogleLoginAdapter.prototype.getAdapterConfig = function(passportValues, existingAdapterConfig) {
	var existingRefreshToken = (existingAdapterConfig && existingAdapterConfig.refreshToken) || null;
	return Promise.resolve({
		uid: passportValues.uid,
		token: passportValues.token,
		tokenExpires: passportValues.tokenExpires,
		refreshToken: passportValues.refreshToken || existingRefreshToken,
		firstName: passportValues.firstName,
		lastName: passportValues.lastName,
		email: passportValues.email
	});
};

function getTokenExpiryDate(duration) {
	var currentTimestamp = Math.floor(new Date().getTime() / 1000);
	var tokenExpiryTimestamp = currentTimestamp + duration;
	var tokenExpiryDate = new Date(tokenExpiryTimestamp * 1000);
	return tokenExpiryDate;
}

function GoogleStorageAdapter(database, cache, options) {
	options = options || {};
	var adapterLabel = options.adapterLabel || null;
	var rootLabel = options.rootLabel || null;
	var defaultSitesPath = options.defaultSitesPath || null;
	var clientId = options.clientId;
	var clientSecret = options.clientSecret;

	if (!database) { throw new Error('Missing database'); }
	if (!cache) { throw new Error('Missing key-value store'); }
	if (!adapterLabel) { throw new Error('Missing adapter label'); }
	if (!rootLabel) { throw new Error('Missing root label'); }
	if (!defaultSitesPath) { throw new Error('Missing sites path'); }
	if (!clientId) { throw new Error('Missing Google OAuth2 client id'); }
	if (!clientSecret) { throw new Error('Missing Google OAuth2 client secret'); }

	StorageAdapter.call(this);

	this.database = database;
	this.cache = cache;
	this.adapterLabel = adapterLabel;
	this.rootLabel = rootLabel;
	this.defaultSitesPath = defaultSitesPath;
	this.clientId = clientId;
	this.clientSecret = clientSecret;
}

util.inherits(GoogleStorageAdapter, StorageAdapter);

GoogleStorageAdapter.prototype.adapterName = 'google';
GoogleStorageAdapter.prototype.database = null;
GoogleStorageAdapter.prototype.cache = null;
GoogleStorageAdapter.prototype.adapterLabel = null;
GoogleStorageAdapter.prototype.rootLabel = null;
GoogleStorageAdapter.prototype.defaultSitesPath = null;
GoogleStorageAdapter.prototype.clientId = null;
GoogleStorageAdapter.prototype.clientSecret = null;

GoogleStorageAdapter.prototype.getMetadata = function(userAdapterConfig) {
	var adapterLabel = this.adapterLabel;
	var rootLabel = this.rootLabel;
	var defaultSitesPath = this.defaultSitesPath;
	var fullName = [userAdapterConfig.firstName, userAdapterConfig.lastName].join(' ');
	return {
		label: adapterLabel,
		rootLabel: rootLabel.replace(/\$\{\s*user\s*\}/g, fullName),
		path: defaultSitesPath
	};
};

GoogleStorageAdapter.prototype.initSiteFolder = function(siteFiles, siteAdapterConfig, userAdapterConfig) {
	var database = this.database;
	var clientId = this.clientId;
	var clientSecret = this.clientSecret;
	var uid = userAdapterConfig.uid;
	var accessToken = userAdapterConfig.token;
	var tokenExpires = userAdapterConfig.tokenExpires;
	var refreshToken = userAdapterConfig.refreshToken;
	var sitePath = siteAdapterConfig.path;
	return new GoogleConnector(database, clientId, clientSecret)
		.connect(uid, accessToken, tokenExpires, refreshToken)
		.then(function(googleClient) {
			return googleClient.retrieveFileMetadataAtPath(sitePath)
				.then(function(fileMetadata) {
					var isFolder = (fileMetadata.mimeType === MIME_TYPE_FOLDER);
					if (!isFolder) { throw new HttpError(409); }
				})
				.catch(function(error) {
					if (error.status === 404) {
						return googleClient.createFolderAtPath(sitePath)
							.then(function(folderMetadata) {
								var parentId = folderMetadata.id;
								var nestedFiles = getFileListing(siteFiles);
								return copyNestedFiles(googleClient, parentId, nestedFiles);
							});
					}
					throw error;
				});
		});


	function getFileListing(namedFiles) {
		var fileEntries = Object.keys(namedFiles)
			.sort(function(filePath1, filePath2) {
				return (filePath1 < filePath2 ? -1 : 1);
			})
			.map(function(filePath) {
				var file = namedFiles[filePath];
				var filename = path.basename(filePath);
				var fileEntry = {
					filename: filename,
					path: filePath,
					contents: file
				};
				return fileEntry;
			});
		var rootFolder = fileEntries.reduce(function(rootFolder, fileEntry) {
			var filePath = fileEntry.path;
			var isNestedFile = filePath.indexOf('/') !== -1;
			var filePathComponents = (isNestedFile ? path.dirname(filePath).split('/') : []);
			var parentFolderEntry = filePathComponents.reduce(function(parentFolderEntry, pathComponent) {
				var folderEntry = getChildFolderEntry(parentFolderEntry, pathComponent);
				return folderEntry;
			}, rootFolder);
			parentFolderEntry.contents.push(fileEntry);
			return rootFolder;
		}, { path: null, contents: [] });
		return rootFolder.contents;


		function getChildFolderEntry(parentFolderEntry, filename) {
			var existingFolder = parentFolderEntry.contents.filter(function(child) {
				return (path.basename(child.path) === filename);
			})[0];
			if (existingFolder) { return existingFolder; }
			var parentPath = parentFolderEntry.path;
			var folderEntry = {
				filename: filename,
				path: (parentPath ? parentPath + '/' : '') + filename,
				contents: []
			};
			parentFolderEntry.contents.push(folderEntry);
			return folderEntry;
		}
	}

	function copyNestedFiles(googleClient, parentId, fileEntries) {
		return Promise.resolve(mapSeries(fileEntries, function(fileEntry) {
			var filename = fileEntry.filename;
			var fileContents = fileEntry.contents;
			var isDirectory = Array.isArray(fileContents);
			if (isDirectory) {
				return googleClient.createFolder(filename, parentId)
					.then(function(folderMetadata) {
						var folderId = folderMetadata.id;
						var folderContents = fileContents;
						return copyNestedFiles(googleClient, folderId, folderContents);
					});
			} else {
				return googleClient.writeFile(filename, parentId, fileContents);
			}
		}).then(function(results) {
			return;
		}));
	}
};

GoogleStorageAdapter.prototype.loadSiteContents = function(siteAdapterConfig, userAdapterConfig) {
	var database = this.database;
	var clientId = this.clientId;
	var clientSecret = this.clientSecret;
	var uid = userAdapterConfig.uid;
	var accessToken = userAdapterConfig.token;
	var tokenExpires = userAdapterConfig.tokenExpires;
	var refreshToken = userAdapterConfig.refreshToken;
	var cache = userAdapterConfig.cache;
	var siteFolderPath = siteAdapterConfig.path;
	return new GoogleConnector(database, clientId, clientSecret)
		.connect(uid, accessToken, tokenExpires, refreshToken)
		.then(function(googleClient) {
			return googleClient.loadFolderContents(siteFolderPath, cache);
		})
		.then(function(fileContents) {
			var folder = parseFileMetadata(fileContents, { root: siteFolderPath });
			return {
				root: folder,
				cache: fileContents
			};
		});

};

GoogleStorageAdapter.prototype.readFile = function(filePath, siteAdapterConfig, userAdapterConfig) {
	var database = this.database;
	var clientId = this.clientId;
	var clientSecret = this.clientSecret;
	var uid = userAdapterConfig.uid;
	var accessToken = userAdapterConfig.token;
	var tokenExpires = userAdapterConfig.tokenExpires;
	var refreshToken = userAdapterConfig.refreshToken;
	var fileId = parseFileId(filePath);
	return new GoogleConnector(database, clientId, clientSecret)
		.connect(uid, accessToken, tokenExpires, refreshToken)
		.then(function(googleClient) {
			return googleClient.readFile(fileId);
		});
};

GoogleStorageAdapter.prototype.retrieveDownloadLink = function(filePath, siteAdapterConfig, userAdapterConfig) {
	var database = this.database;
	var cache = this.cache;
	var clientId = this.clientId;
	var clientSecret = this.clientSecret;
	var uid = userAdapterConfig.uid;
	var accessToken = userAdapterConfig.token;
	var tokenExpires = userAdapterConfig.tokenExpires;
	var refreshToken = userAdapterConfig.refreshToken;
	var fileId = parseFileId(filePath);
	var filename = path.basename(filePath);
	return new GoogleConnector(database, clientId, clientSecret)
		.connect(uid, accessToken, tokenExpires, refreshToken)
		.then(function(googleClient) {
			return googleClient.generateDownloadLink(fileId)
				.then(function(downloadUrl) {
					return sanitizeUrl(downloadUrl, cache, { filename: filename });
				});
		});
};

GoogleStorageAdapter.prototype.retrievePreviewLink = function(filePath, siteAdapterConfig, userAdapterConfig) {
	var database = this.database;
	var cache = this.cache;
	var clientId = this.clientId;
	var clientSecret = this.clientSecret;
	var uid = userAdapterConfig.uid;
	var accessToken = userAdapterConfig.token;
	var tokenExpires = userAdapterConfig.tokenExpires;
	var refreshToken = userAdapterConfig.refreshToken;
	var fileId = parseFileId(filePath);
	var filename = path.basename(filePath);
	return new GoogleConnector(database, clientId, clientSecret)
		.connect(uid, accessToken, tokenExpires, refreshToken)
		.then(function(googleClient) {
			return googleClient.generateDownloadLink(fileId)
				.then(function(previewUrl) {
					return sanitizeUrl(previewUrl, cache, { filename: filename, inline: true });
				});
		});
};

GoogleStorageAdapter.prototype.retrieveThumbnailLink = function(filePath, userAdapterConfig) {
	var database = this.database;
	var cache = this.cache;
	var clientId = this.clientId;
	var clientSecret = this.clientSecret;
	var uid = userAdapterConfig.uid;
	var accessToken = userAdapterConfig.token;
	var tokenExpires = userAdapterConfig.tokenExpires;
	var refreshToken = userAdapterConfig.refreshToken;
	var fileId = parseFileId(filePath);
	var filename = path.basename(filePath);
	return new GoogleConnector(database, clientId, clientSecret)
		.connect(uid, accessToken, tokenExpires, refreshToken)
		.then(function(googleClient) {
			return googleClient.generateThumbnailLink(fileId, { size: THUMBNAIL_SIZE })
				.then(function(thumbnailUrl) {
					return sanitizeUrl(thumbnailUrl, cache, { filename: filename, inline: true });
				});
		});
};

GoogleStorageAdapter.prototype.retrieveFileMetadata = function(filePath, userAdapterConfig) {
	var database = this.database;
	var clientId = this.clientId;
	var clientSecret = this.clientSecret;
	var uid = userAdapterConfig.uid;
	var accessToken = userAdapterConfig.token;
	var tokenExpires = userAdapterConfig.tokenExpires;
	var refreshToken = userAdapterConfig.refreshToken;
	return new GoogleConnector(database, clientId, clientSecret)
		.connect(uid, accessToken, tokenExpires, refreshToken)
		.then(function(googleClient) {
			return googleClient.retrieveFileMetadataAtPath(filePath)
				.then(function(fileMetadata) {
					return parseFileMetadata(fileMetadata, { root: null });
				});
		});
};

GoogleStorageAdapter.prototype.getUploadConfig = function(siteAdapterConfig, userAdapterConfig) {
	return {
		name: this.adapterName,
		config: {
			path: siteAdapterConfig.path,
			token: userAdapterConfig.token
		}
	};
};

module.exports = {
	LoginAdapter: GoogleLoginAdapter,
	StorageAdapter: GoogleStorageAdapter,
	Client: GoogleClient
};


function parseFileMetadata(fileMetadata, options) {
	options = options || {};
	var rootPath = options.root || '';
	if (!fileMetadata) { return null; }
	if (fileMetadata.trashed) { return null; }
	return createFileModel(fileMetadata, rootPath);


	function createFileModel(fileData, rootPath) {
		var isDirectory = (fileData.mimeType === MIME_TYPE_FOLDER);
		return new FileModel({
			id: fileData.id,
			path: stripRootPrefix(fileData.path, rootPath) || '/',
			mimeType: (isDirectory ? null : fileData.mimeType),
			size: Number(fileData.fileSize || 0),
			modified: fileData.modifiedDate,
			thumbnail: fileData.thumbnailLink && getResizedThumbnailLink(fileData.thumbnailLink, { size: 's' + THUMBNAIL_SIZE }),
			directory: isDirectory,
			contents: (fileData.children ? fileData.children.map(function(childFileMetadata) {
				return createFileModel(childFileMetadata, rootPath);
			}) : null)
		});
	}

	function stripRootPrefix(filePath, rootPath) {
		return filePath.replace(new RegExp('^' + escapeRegExp(rootPath), 'i'), '');
	}
}

function parseFileId(filePath) {
	return path.basename(filePath.replace(/\/(.*?)\.[^\/]+?$/, ''));
}

function GoogleConnector(database, clientId, clientSecret) {
	if (!database) { throw new Error('Missing database'); }
	if (!clientId) { throw new Error('Missing client ID'); }
	if (!clientSecret) { throw new Error('Missing client secret'); }

	this.database = database;
	this.clientId = clientId;
	this.clientSecret = clientSecret;
}

GoogleConnector.prototype.adapterName = 'google';
GoogleConnector.prototype.database = null;
GoogleConnector.prototype.clientId = null;
GoogleConnector.prototype.clientSecret = null;

GoogleConnector.prototype.connect = function(uid, accessToken, tokenExpires, refreshToken) {
	if (!uid) { return Promise.reject(new Error('Missing user ID')); }
	if (!accessToken) { return Promise.reject(new Error('Missing access token')); }
	if (!tokenExpires) { return Promise.reject(new Error('Missing access token expiry date')); }
	if (!refreshToken) { return Promise.reject(new Error('Missing refresh token')); }

	var clientId = this.clientId;
	var clientSecret = this.clientSecret;
	var adapterName = this.adapterName;

	var userService = new UserService(this.database);

	return login(clientId, clientSecret, accessToken, tokenExpires, refreshToken)
		.then(function(authDetails) {
			var existingDetails = {
				token: accessToken,
				tokenExpires: tokenExpires,
				refreshToken: refreshToken
			};
			var authDetailsHaveChanged = !isEqual(authDetails, existingDetails);
			return (authDetailsHaveChanged ? userService.updateUserAdapterSettings(adapterName, uid, authDetails) : Promise.resolve())
				.then(function() {
					return authDetails;
				});
		})
		.then(function(authDetails) {
			var accessToken = authDetails.token;
			return new GoogleClient(accessToken);
		});


	function login(clientId, clientSecret, accessToken, tokenExpires, refreshToken) {
		var tokenExpiryDate = new Date(tokenExpires);
		var isAccessTokenValid = getIsAccessTokenValid(accessToken, tokenExpiryDate);
		if (isAccessTokenValid) {
			return Promise.resolve({
				token: accessToken,
				tokenExpires: tokenExpires,
				refreshToken: refreshToken
			});
		} else {
			return renewAccessToken(clientId, clientSecret, accessToken, refreshToken)
				.then(function(authDetails) {
					var accessToken = authDetails.token;
					var tokenExpires = authDetails.tokenExpires;
					var refreshToken = authDetails.refreshToken;
					return {
						token: accessToken,
						tokenExpires: tokenExpires,
						refreshToken: refreshToken
					};
				});
		}


		function getIsAccessTokenValid(accessToken, tokenExpiryDate) {
			if (!accessToken || !tokenExpiryDate) { return false; }
			var tokenExpiryTimestamp = Math.floor(tokenExpiryDate.getTime() / 1000);
			var currentTimestamp = Math.floor(new Date().getTime() / 1000);
			return (tokenExpiryTimestamp - currentTimestamp) >= MIN_TOKEN_VALIDITY_DURATION;
		}

		function renewAccessToken(clientId, clientSecret, accessToken, refreshToken) {
			return apiRequest({
				token: null,
				method: 'POST',
				url: OAUTH2_TOKEN_URL,
				params: {
					'grant_type': 'refresh_token',
					'client_id': clientId,
					'client_secret': clientSecret,
					'refresh_token': refreshToken
				}
			}).then(function(response) {
				var accessToken = response['access_token'];
				var tokenDuration = response['expires_in'];
				var tokenExpires = getTokenExpiryDate(tokenDuration).toISOString();
				return {
					token: accessToken,
					tokenExpires: tokenExpires,
					refreshToken: refreshToken
				};
			});
		}
	}
};

function GoogleClient(accessToken) {
	this.accessToken = accessToken;
}

GoogleClient.prototype.accessToken = null;

GoogleClient.prototype.retrieveFileMetadataAtPath = function(filePath) {
	var accessToken = this.accessToken;
	return retrieveFileMetadataAtPath(filePath, accessToken);


	function retrieveFileMetadataAtPath(filePath, accessToken) {
		return loadFolderHierarchy(accessToken)
			.then(function(rootFolder) {
				if (filePath === '/') {
					return stripChildren(rootFolder);
				}
				var parentPath = path.dirname(filePath);
				var relativeParentPath = stripLeadingSlash(parentPath);
				var parentFolder = getNestedFile(rootFolder, relativeParentPath);
				if (!parentFolder) {
					throw new HttpError(404);
				}
				var relativeFilePath = stripLeadingSlash(filePath);
				var folder = getNestedFile(rootFolder, relativeFilePath);
				if (folder) { return stripChildren(folder); }
				var filename = path.basename(filePath);
				var query = '(\'' + parentFolder.id + '\' in parents) and (title = \'' + escapeApiQueryString(filename) + '\')';
				return loadFileList(query, accessToken)
					.then(function(items) {
						if (items.length === 0) {
							throw new HttpError(404);
						}
						var files = parseFileList(items);
						return files[0];
					});
			});


		function stripChildren(folder) {
			return objectAssign({}, folder, { children: null });
		}
	}
};

GoogleClient.prototype.loadFolderContents = function(folderPath, folderCache) {
	var accessToken = this.accessToken;
	return loadFolder(folderPath, folderCache, accessToken);


	function loadFolder(folderPath, folderCache, accessToken) {
		return loadFolderHierarchy(accessToken)
			.then(function(rootFolder) {
				var relativeFolderPath = stripLeadingSlash(folderPath);
				var folder = getNestedFile(rootFolder, relativeFolderPath);
				if (!folder) { throw new HttpError(404); }
				var folderId = folder.id;
				return loadFolderContents(folderId, accessToken)
					.then(function(items) {
						var baseFolderItem = createFolderItem({ id: folder.id, title: folder.filename, root: true });
						var nestedFiles = parseFileList([baseFolderItem].concat(items));
						var baseFolder = nestedFiles.filter(function(file) {
							return file.id === baseFolderItem.id;
						})[0];
						return baseFolder;
					});
			});
	}
};

GoogleClient.prototype.readFile = function(fileId) {
	var accessToken = this.accessToken;
	return readFile(fileId, accessToken);
};

GoogleClient.prototype.writeFile = function(filename, parentFolderId, data) {
	var accessToken = this.accessToken;
	return writeFile(filename, parentFolderId, data, accessToken);
};

GoogleClient.prototype.createFolder = function(filename, parentFolderId) {
	var accessToken = this.accessToken;
	return createFolder(filename, parentFolderId, accessToken);
};

GoogleClient.prototype.createFolderAtPath = function(folderPath) {
	var client = this;
	var accessToken = this.accessToken;
	return createFolderAtPath(folderPath, accessToken);


	function createFolderAtPath(folderPath, accessToken) {
		if (!folderPath || (folderPath.charAt(0) !== '/')) {
			return Promise.reject(new HttpError(400));
		}
		if (folderPath === '/') {
			return Promise.resolve(createFolderItem({ id: 'root', root: true }));
		}
		var filename = path.basename(folderPath);
		var parentPath = path.dirname(folderPath);
		return client.retrieveFileMetadataAtPath(parentPath)
			.catch(function(error) {
				if (error.status === 404) {
					return createFolderAtPath(parentPath, accessToken);
				} else {
					throw error;
				}
			})
			.then(function(fileMetadata) {
				if (fileMetadata.mimeType !== MIME_TYPE_FOLDER) {
					throw new HttpError(409);
				}
				var parentId = fileMetadata.id;
				return client.createFolder(filename, parentId);
			});
	}
};

GoogleClient.prototype.generateDownloadLink = function(fileId) {
	var accessToken = this.accessToken;
	return generateDownloadLink(fileId, accessToken);
};

GoogleClient.prototype.generateThumbnailLink = function(fileId, options) {
	var accessToken = this.accessToken;
	return generateThumbnailLink(fileId, options, accessToken);
};

function loadFolderHierarchy(accessToken) {
	return loadUserFolders(accessToken)
		.then(function(folders) {
			var rootFolderId = getRootFolderId(folders);
			var rootFolderItem = createFolderItem({ id: rootFolderId, title: null, root: true });
			var nestedFiles = parseFileList([rootFolderItem].concat(folders.map(function(item) {
				return createFolderItem(item);
			})));
			var linkedRootFolder = nestedFiles.filter(function(file) {
				return file.id === rootFolderId;
			})[0];
			return linkedRootFolder;
		});


	function getRootFolderId(files) {
		var rootFolderId = null;
		files.forEach(function(file) {
			if (rootFolderId) { return; }
			var rootFolderReference = file.parents.filter(function(parentReference) {
				return parentReference.isRoot;
			})[0];
			if (!rootFolderReference) { return; }
			rootFolderId = rootFolderReference.id;
		});
		return rootFolderId || 'root';
	}
}

function getNestedFile(currentFolder, filePath) {
	if (!filePath) { return currentFolder; }
	var pathSegments = filePath.split('/');
	return pathSegments.reduce(function(currentFolder, pathSegment) {
		if (!currentFolder) { return null; }
		if (!currentFolder.children) { return null; }
		var matchingChild = currentFolder.children.filter(function(child) {
			return (child.filename === pathSegment);
		})[0];
		return matchingChild || null;
	}, currentFolder);
}

function createFolderItem(options) {
	options = options || {};
	var id = options.id || null;
	var title = options.title || null;
	var modifiedDate = options.modifiedDate || new Date().toISOString();
	var parents = options.parents || [];
	var isRoot = Boolean(options.root);
	return {
		id: id,
		title: title,
		mimeType: MIME_TYPE_FOLDER,
		modifiedDate: modifiedDate,
		parents: parents,
		isRoot: isRoot
	};
}

function parseFileList(items) {
	var parsedFiles = items.map(function(item) {
		return parseFileItem(item);
	});
	var indexedFiles = parsedFiles.reduce(function(indexedFiles, parsedFile) {
		indexedFiles[parsedFile.id] = parsedFile;
		return indexedFiles;
	}, {});
	var indexedFileParents = items.reduce(function(indexedFileParents, item) {
		var fileParents = item.parents.map(function(parentReference) {
			var isImplicitRootReference = parentReference.isRoot && !(parentReference.id in indexedFiles) && ('root' in indexedFiles);
			if (isImplicitRootReference) { return indexedFiles['root']; }
			return indexedFiles[parentReference.id];
		}).filter(function(parentFile) {
			var parentExists = Boolean(parentFile);
			return parentExists;
		});
		indexedFileParents[item.id] = fileParents;
		return indexedFileParents;
	}, {});
	items.forEach(function(item) {
		var fileId = item.id;
		var parsedFile = indexedFiles[fileId];
		var fileParents = indexedFileParents[fileId];
		fileParents.forEach(function(parentFile) {
			parentFile.children.push(parsedFile);
		});
		var primaryParent = fileParents[0];
		if (primaryParent) {
			var parentPath = primaryParent.path;
			var pathPrefix = (parentPath === '/' ? '' : parentPath);
			parsedFile.path = pathPrefix + parsedFile.path;
			prefixChildPaths(parsedFile, pathPrefix);
		}
	});
	return parsedFiles;


	function parseFileItem(data, parentPath) {
		parentPath = parentPath || '/';
		var pathPrefix = parentPath + (parentPath === '/' ? '' : '/');
		var isDirectory = (data.mimeType === MIME_TYPE_FOLDER);
		return {
			id: data.id,
			filename: data.title,
			path: (data.isRoot ? '/' : pathPrefix + data.title),
			modifiedDate: data.modifiedDate,
			mimeType: data.mimeType,
			fileSize: (isDirectory ? null : Number(data.fileSize)),
			thumbnailLink: data.thumbnailLink || undefined,
			children: (isDirectory ? [] : undefined)
		};
	}

	function prefixChildPaths(folder, pathPrefix) {
		var isFolder = Boolean(folder.children);
		if (!isFolder) { return; }
		folder.children.forEach(function(file) {
			file.path = pathPrefix + file.path;
			prefixChildPaths(file, pathPrefix);
		});
	}
}

function loadUserFolders(accessToken) {
	return apiRequest({
		token: accessToken,
		method: 'GET',
		url: 'https://www.googleapis.com/drive/v2/files',
		params: {
			'spaces': 'drive',
			'q': 'mimeType=\'application/vnd.google-apps.folder\' and trashed=false',
			'maxResults': MAX_API_RESULTS
		},
		fields: {
			'items': {
				'id': true,
				'title': true,
				'parents': {
					'id': true,
					'isRoot': true
				}
			}
		},
		paginated: true
	}).then(function(data) {
		return data.items;
	});
}

function loadFolderContents(folderId, accessToken, existingItems) {
	var folderIds = (Array.isArray(folderId) ? folderId : [folderId]);
	var query = folderIds.map(function(folderId) {
		return '(\'' + folderId + '\' in parents)';
	}).join(' or ');
	return loadFileList(query, accessToken)
		.then(function(items) {
			var folderItems = items.filter(function(item) {
				return (item.mimeType === MIME_TYPE_FOLDER);
			});
			var combinedItems = (existingItems ? existingItems.concat(items) : items);
			if (folderItems.length === 0) {
				return combinedItems;
			} else {
				var nestedFolderIds = folderItems.map(function(folderItem) {
					return folderItem.id;
				});
				return loadFolderContents(nestedFolderIds, accessToken, combinedItems);
			}
		});
}

function loadFileList(query, accessToken) {
	var q = (query ? '(' + query + ') and ' : '') + 'trashed=false';
	return apiRequest({
		token: accessToken,
		method: 'GET',
		url: 'https://www.googleapis.com/drive/v2/files',
		params: {
			'spaces': 'drive',
			'q': q,
			'maxResults': MAX_API_RESULTS
		},
		fields: {
			'items': {
				'id': true,
				'title': true,
				'alternateLink': true,
				'downloadUrl': true,
				'fileSize': true,
				'fullFileExtension': true,
				'mimeType': true,
				'modifiedDate': true,
				'thumbnailLink': true,
				'webContentLink': true,
				'parents': {
					'id': true,
					'isRoot': true
				}
			}
		},
		paginated: true
	}).then(function(data) {
		return data.items;
	});
}

function readFile(fileId, accessToken) {
	return apiRequest({
		token: accessToken,
		method: 'GET',
		url: 'https://www.googleapis.com/drive/v2/files/' + fileId,
		params: {
			'alt': 'media'
		},
		raw: true
	});
}

function writeFile(filename, parentFolderId, data, accessToken) {
	var mimeType = mime.lookup(filename);
	var fileMetadata = {
		title: filename,
		mimeType: mimeType,
		parents: [ { id: parentFolderId } ]
	};
	return apiRequest({
		token: accessToken,
		method: 'POST',
		url: 'https://www.googleapis.com/upload/drive/v2/files',
		body: [
			{ 'Content-Type': 'application/json; charset=UTF-8', body: JSON.stringify(fileMetadata) },
			{ 'Content-Type': mimeType, body: data }
		]
	});
}

function createFolder(filename, parentFolderId, accessToken) {
	var fileMetadata = {
		title: filename,
		mimeType: MIME_TYPE_FOLDER,
		parents: [ { id: parentFolderId } ]
	};
	return apiRequest({
		token: accessToken,
		method: 'POST',
		url: 'https://www.googleapis.com/drive/v2/files',
		body: fileMetadata
	})
	.then(function(data) {
		return createFolderItem(data);
	});
}

function generateDownloadLink(fileId, accessToken) {
	return apiRequest({
		token: accessToken,
		method: 'GET',
		url: 'https://www.googleapis.com/drive/v2/files/' + fileId,
		fields: {
			'downloadUrl': true
		}
	})
	.then(function(response) {
		var downloadUrl = response.downloadUrl;
		if (!downloadUrl) { return new HttpError(403); }
		return appendQueryParams(downloadUrl, { 'access_token': accessToken });
	});
}

function generateThumbnailLink(fileId, options, accessToken) {
	options = options || {};
	var size = options.size || null;
	if (typeof size === 'number') { size = 's' + size; }
	return apiRequest({
		token: accessToken,
		method: 'GET',
		url: 'https://www.googleapis.com/drive/v2/files/' + fileId,
		fields: {
			'thumbnailLink': true
		}
	})
	.then(function(response) {
		var thumbnailLink = response.thumbnailLink;
		if (!thumbnailLink) { return new HttpError(403); }
		if (size) { thumbnailLink = getResizedThumbnailLink(thumbnailLink, { size: size }); }
		return thumbnailLink;
	});
}

function getResizedThumbnailLink(thumbnailLink, options) {
	options = options || {};
	var size = options.size || null;
	return thumbnailLink.replace(/=(\w\d+)+$/, (size ? '=' + size : ''));
}

function apiRequest(options) {
	var isPaginated = Boolean(options.paginated);
	if (isPaginated) {
		return loadPaginatedResults(options, null, null);
	} else {
		return processApiRequest(options);
	}

	function loadPaginatedResults(options, pageToken, partialResponse) {
		var fields = (options.fields ? objectAssign({}, options.fields, { 'nextPageToken': true }) : null);
		var params = objectAssign({}, options.params, (pageToken ? { 'pageToken': pageToken } : null));
		var paginatedOptions = objectAssign({}, options, { fields: fields, params: params });
		return processApiRequest(paginatedOptions)
			.then(function(response) {
				var combinedResponse = (partialResponse ? objectAssign({}, partialResponse, { items: partialResponse.items.concat(response.items) }) : response);
				var hasNextPage = Boolean(response.nextPageToken);
				if (hasNextPage) {
					var nextPageToken = response.nextPageToken;
					return loadPaginatedResults(options, nextPageToken, combinedResponse);
				} else {
					return combinedResponse;
				}
			});
	}

	function processApiRequest(options) {
		var isMultipartBody = Array.isArray(options.body);
		var params = objectAssign(
			{},
			options.params,
			(options.fields ? { 'fields': formatFieldProjection(options.fields) } : null),
			(isMultipartBody ? { 'uploadType': 'multipart' } : null)
		);
		var url = appendQueryParams(options.url, params);
		var method = options.method || 'GET';
		var headers = objectAssign(options.token ? { 'Authorization': 'Bearer ' + options.token } : {}, options.headers);
		var body = (options.body && !isMultipartBody ? options.body : undefined);
		var multipartData = (options.body && isMultipartBody ? options.body : undefined);
		var isRawResponse = options.raw;

		return new Promise(function(resolve, reject) {
			request({
				method: method,
				url: url,
				headers: headers,
				body: body,
				multipart: multipartData,
				json: !isRawResponse
			}, function (error, response, body) {
				if (error) { return reject(error); }
				if (response.statusCode >= 400) {
					return reject(new HttpError(response.statusCode, getErrorMessage(body)));
				}
				return resolve(body);
			});
		});


		function formatFieldProjection(fields) {
			if (!fields) { return null; }
			return Object.keys(fields).map(function(key) {
				var value = fields[key];
				if (!value) {
					return null;
				} else if (value === true) {
					return key;
				} else if (typeof value === 'object') {
					return key + '(' + formatFieldProjection(value) + ')';
				}
			}).filter(function(value) {
				return Boolean(value);
			}).join(',');
		}

		function getErrorMessage(apiResponse) {
			if (typeof apiResponse === 'string') {
				try {
					apiResponse = JSON.parse(apiResponse);
				} catch (error) {
					return apiResponse;
				}
			}
			return (apiResponse && apiResponse.error && apiResponse.error.message) || apiResponse;
		}
	}
}

function sanitizeUrl(inputUrl, cache, options) {
	options = options || {};
	var filename = options.filename || null;
	var isInline = Boolean(options.inline);
	var parseQueryString = true;
	var params = url.parse(inputUrl, parseQueryString).query;
	var isPrivateUrl = ('access_token' in params);
	return (isPrivateUrl ? createTemporaryUrl(inputUrl, cache, { filename: filename, inline: isInline }) : inputUrl);


	function createTemporaryUrl(url, cache, options) {
		options = options || {};
		var filename = options.filename || null;
		var isInline = Boolean(options.inline);
		var redirectService = new RedirectService(cache);
		return redirectService.create(url, { timeout: DOWNLOAD_LINK_DURATION })
			.then(function(id) {
				return '/dl/' + id + (filename ? '/' + encodeURIComponent(filename) : '') + (isInline ? '?inline=true' : '');
			});
	}
}

function stripLeadingSlash(string) {
	var REGEXP_LEADING_SLASH = /^\/+/;
	return string.replace(REGEXP_LEADING_SLASH, '');
}

function escapeApiQueryString(string) {
	return string.replace(/'/g, '\\\'');
}
