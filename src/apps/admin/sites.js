'use strict';

var assert = require('assert');
var express = require('express');
var merge = require('lodash.merge');

var handlebarsEngine = require('../../engines/handlebars');

var readDirContentsSync = require('../../utils/readDirContentsSync');

var HttpError = require('../../errors/HttpError');

var UserService = require('../../services/UserService');
var SiteService = require('../../services/SiteService');
var ThemeService = require('../../services/ThemeService');
var FileUploadService = require('../../services/FileUploadService');
var AdminPageService = require('../../services/AdminPageService');

module.exports = function(database, options) {
	options = options || {};
	var host = options.host || null;
	var templatesPath = options.templatesPath || null;
	var partialsPath = options.partialsPath || null;
	var themesPath = options.themesPath || null;
	var siteTemplatePath = options.siteTemplatePath || null;
	var siteAuthOptions = options.siteAuthOptions || null;
	var themesUrl = options.themesUrl || null;
	var adapters = options.adapters || null;
	var uploadAdapter = options.uploadAdapter || null;
	var sessionMiddleware = options.sessionMiddleware || null;
	var analyticsConfig = options.analytics || null;

	assert(database, 'Missing database');
	assert(host, 'Missing host details');
	assert(templatesPath, 'Missing templates path');
	assert(partialsPath, 'Missing partials path');
	assert(themesPath, 'Missing themes path');
	assert(siteTemplatePath, 'Missing site template path');
	assert(siteAuthOptions, 'Missing site auth options');
	assert(themesUrl, 'Missing theme gallery URL');
	assert(adapters, 'Missing adapters');
	assert(uploadAdapter, 'Missing upload adapter');
	assert(sessionMiddleware, 'Missing session middleware');
	assert(analyticsConfig, 'Missing analytics configuration');

	var siteTemplateFiles = readDirContentsSync(siteTemplatePath);

	var userService = new UserService(database);
	var siteService = new SiteService(database, {
		host: host,
		adapters: adapters
	});
	var themeService = new ThemeService({
		themesPath: themesPath
	});
	var fileUploadService = new FileUploadService({
		adapter: uploadAdapter
	});
	var adminPageService = new AdminPageService({
		templatesPath: templatesPath,
		partialsPath: partialsPath,
		sessionMiddleware: sessionMiddleware,
		analytics: analyticsConfig
	});

	var app = express();

	initRoutes(app);

	initViewEngine(app, {
		templatesPath: templatesPath
	});

	return app;


	function initViewEngine(app, options) {
		options = options || {};
		var templatesPath = options.templatesPath;

		app.engine('hbs', handlebarsEngine);
		app.set('views', templatesPath);
		app.set('view engine', 'hbs');
	}

	function initRoutes(app) {
		app.get('/', retrieveSitesRoute);
		app.post('/', createSiteRoute);
		app.get('/create-canvas', retrieveCreateSiteRoute);
		app.get('/create-canvas/themes', retrieveCreateSiteThemesRoute);
		app.get('/create-canvas/themes/:theme', retrieveCreateSiteThemeRoute);
		app.get('/:site', retrieveSiteRoute);
		app.put('/:site', updateSiteRoute);
		app.delete('/:site', deleteSiteRoute);

		app.get('/:site/users', retrieveSiteUsersRoute);
		app.post('/:site/users', createSiteUserRoute);
		app.put('/:site/users/:username', updateSiteUserRoute);
		app.delete('/:site/users/:username', deleteSiteUserRoute);

		app.get('/:site/edit', retrieveSiteEditRoute);
		app.post('/:site/edit/upload/:filename', prefixUserUploadPath('filename'), fileUploadService.middleware());


		function retrieveSitesRoute(req, res, next) {
			new Promise(function(resolve, reject) {
				var templateData = {
					content: {
						themes: themeService.getThemes()
					}
				};
				resolve(
					adminPageService.render(req, res, {
						template: 'sites',
						context: templateData
					})
				);
			})
			.catch(function(error) {
				next(error);
			});
		}

		function retrieveCreateSiteRoute(req, res, next) {
			var userAdapters = req.user.adapters;
			var theme = req.query.theme || null;

			new Promise(function(resolve, reject) {
				var adaptersMetadata = Object.keys(userAdapters).filter(function(adapterName) {
					return adapterName !== 'default';
				}).reduce(function(adaptersMetadata, adapterName) {
					var adapter = adapters[adapterName];
					var userAdapterConfig = userAdapters[adapterName];
					adaptersMetadata[adapterName] = adapter.getMetadata(userAdapterConfig);
					return adaptersMetadata;
				}, {});
				var defaultAdapterName = userAdapters.default;
				var defaultAdapterPath = adaptersMetadata[defaultAdapterName].path;
				var siteModel = {
					name: '',
					label: '',
					root: {
						adapter: defaultAdapterName,
						path: defaultAdapterPath
					},
					private: false,
					published: false,
					home: false,
					theme: theme
				};
				var templateData = {
					content: {
						site: siteModel,
						themes: themeService.getThemes(),
						adapters: adaptersMetadata
					}
				};
				resolve(
					adminPageService.render(req, res, {
						template: 'sites/create-site',
						context: templateData
					})
				);
			})
			.catch(function(error) {
				next(error);
			});
		}

		function retrieveCreateSiteThemesRoute(req, res, next) {
			new Promise(function(resolve, reject) {
				var themes = themeService.getThemes();
				var themeIds = Object.keys(themes);
				if (themeIds.length === 0) { throw new HttpError(404); }
				var firstThemeId = themeIds[0];
				resolve(
					res.redirect('/canvases/create-canvas/themes/' + firstThemeId)
				);
			})
			.catch(function(error) {
				next(error);
			});
		}

		function retrieveCreateSiteThemeRoute(req, res, next) {
			var themeId = req.params.theme;

			new Promise(function(resolve, reject) {
				var themes = themeService.getThemes();
				var theme = themeService.getTheme(themeId);
				var previousTheme = themeService.getPreviousTheme(themeId);
				var nextTheme = themeService.getNextTheme(themeId);
				var templateData = {
					content: {
						themes: themes,
						theme: theme,
						previousTheme: previousTheme,
						nextTheme: nextTheme
					}
				};
				resolve(
					adminPageService.render(req, res, {
						template: 'sites/create-site/themes/theme',
						context: templateData
					})
				);
			})
			.catch(function(error) {
				next(error);
			});
		}

		function createSiteRoute(req, res, next) {
			var userModel = req.user;
			var username = userModel.username;
			var redirectUrl = req.body['_redirect'] || ('/canvases/' + req.body.name);

			var isDefaultSite = (req.body.home === 'true');
			var isPrivate = (req.body.private === 'true');
			var isPublished = (req.body.published === 'true');

			var themeId = req.body.theme && req.body.theme.id || null;
			var themeConfig = req.body.theme && req.body.theme.config || null;
			if (typeof themeConfig === 'string') {
				try {
					themeConfig = JSON.parse(themeConfig);
				} catch(error) {
					return next(new HttpError(400));
				}
			}

			var isClone = (req.body._action === 'clone');
			var cloneSourceName = req.body.site || null;

			if (!themeId && !isClone) {
				return next(new HttpError(400));
			}
			if (isClone && !cloneSourceName) {
				return next(new HttpError(400));
			}

			new Promise(function(resolve, reject) {
				resolve(
					retrieveSiteTheme(username, (isClone ? cloneSourceName : null), themeId, themeConfig)
						.then(function(theme) {
							var siteModel = {
								'owner': username,
								'name': req.body.name,
								'label': req.body.label,
								'theme': theme,
								'root': req.body.root || null,
								'private': isPrivate,
								'users': [],
								'published': isPublished,
								'cache': null
							};

							return siteService.createSite(siteModel, siteTemplateFiles)
								.then(function(siteModel) {
									if (!isDefaultSite) { return siteModel; }
									return userService.updateUserDefaultSiteName(username, siteModel.name)
										.then(function() {
											return siteModel;
										});
								})
								.then(function(siteModel) {
									res.redirect(303, redirectUrl);
								});
						})
				);
			})
			.catch(function(error) {
				next(error);
			});


			function retrieveSiteTheme(username, siteName, themeId, themeConfig) {
				return Promise.resolve(
					siteName ?
						siteService.retrieveSite(username, siteName, { theme: true })
							.then(function(siteModel) {
								return siteModel.theme;
							})
					:
						null
				)
					.then(function(baseTheme) {
						if (baseTheme && themeId && (themeId !== baseTheme.id)) { baseTheme = null; }
						var overriddenThemeId = themeId || baseTheme.id;
						var themeConfigDefaults = (baseTheme ? baseTheme.config : themeService.getTheme(overriddenThemeId).defaults);
						var overriddenThemeConfig = merge({}, themeConfigDefaults, themeConfig);
						return {
							id: overriddenThemeId,
							config: overriddenThemeConfig
						};
					});
			}
		}

		function retrieveSiteRoute(req, res, next) {
			var userModel = req.user;
			var username = userModel.username;
			var defaultSiteName = userModel.defaultSite;
			var siteName = req.params.site;
			var userAdapters = req.user.adapters;

			new Promise(function(resolve, reject) {
				var adaptersMetadata = Object.keys(userAdapters).filter(function(adapterName) {
					return adapterName !== 'default';
				}).reduce(function(adaptersMetadata, adapterName) {
					var adapter = adapters[adapterName];
					var userAdapterConfig = userAdapters[adapterName];
					adaptersMetadata[adapterName] = adapter.getMetadata(userAdapterConfig);
					return adaptersMetadata;
				}, {});
				var includeTheme = false;
				var includeContents = false;
				var includeUsers = true;
				resolve(
					siteService.retrieveSite(username, siteName, {
						theme: includeTheme,
						contents: includeContents,
						users: includeUsers
					})
						.then(function(siteModel) {
							var isDefaultSite = (siteModel.name === defaultSiteName);
							siteModel.home = isDefaultSite;
							return siteModel;
						})
						.then(function(siteModel) {
							var templateData = {
								content: {
									site: siteModel,
									adapters: adaptersMetadata
								}
							};
							return adminPageService.render(req, res, {
								template: 'sites/site',
								context: templateData
							});
						})
				);
			})
			.catch(function(error) {
				next(error);
			});
		}

		function updateSiteRoute(req, res, next) {
			var isPurgeRequest = (req.body._action === 'purge');
			if (isPurgeRequest) {
				return purgeSiteRoute(req, res, next);
			}
			var userModel = req.user;
			var username = userModel.username;
			var defaultSiteName = userModel.defaultSite;
			var siteName = req.params.site;

			var updates = {};
			if (req.body.name) { updates.name = req.body.name; }
			if (req.body.label) { updates.label = req.body.label; }
			if (req.body.theme) { updates.theme = req.body.theme; }
			if (req.body.root) { updates.root = req.body.root || null; }
			if (req.body.private) { updates.private = req.body.private === 'true'; }
			if (req.body.published) { updates.published = req.body.published === 'true'; }

			new Promise(function(resolve, reject) {
				var isDefaultSite = siteName === defaultSiteName;
				var isUpdatedDefaultSite = ('home' in req.body ? req.body.home === 'true' : isDefaultSite);
				var updatedSiteName = ('name' in updates ? updates.name : siteName);
				resolve(
					siteService.updateSite(username, siteName, updates)
						.then(function() {
							var updatedDefaultSiteName = (isUpdatedDefaultSite ? updatedSiteName : (isDefaultSite ? null : defaultSiteName));
							if (updatedDefaultSiteName === defaultSiteName) { return; }
							return userService.updateUserDefaultSiteName(username, updatedDefaultSiteName);
						})
						.then(function() {
							res.redirect(303, '/canvases/' + updatedSiteName);
						})
				);
			})
			.catch(function(error) {
				next(error);
			});
		}

		function purgeSiteRoute(req, res, next) {
			var userModel = req.user;
			var username = userModel.username;
			var siteName = req.params.site;

			new Promise(function(resolve, reject) {
				var cache = null;
				resolve(
					siteService.updateSiteCache(username, siteName, cache)
						.then(function() {
							res.redirect(303, '/canvases/' + siteName);
						})
				);
			})
			.catch(function(error) {
				next(error);
			});
		}

		function deleteSiteRoute(req, res, next) {
			var userModel = req.user;
			var username = userModel.username;
			var siteName = req.params.site;

			new Promise(function(resolve, reject) {
				resolve(
					siteService.deleteSite(username, siteName)
						.then(function(siteModel) {
							res.redirect(303, '/canvases');
						})
				);
			})
			.catch(function(error) {
				next(error);
			});
		}

		function retrieveSiteUsersRoute(req, res, next) {
			var userModel = req.user;
			var username = userModel.username;
			var siteName = req.params.site;

			new Promise(function(resolve, reject) {
				var includeTheme = false;
				var includeContents = false;
				var includeUsers = true;
				resolve(
					siteService.retrieveSite(username, siteName, {
						theme: includeTheme,
						contents: includeContents,
						users: includeUsers
					})
					.then(function(siteModel) {
						var templateData = {
							content: {
								site: siteModel
							}
						};
						return adminPageService.render(req, res, {
							template: 'sites/site/users',
							context: templateData
						});
					})
				);
			})
			.catch(function(error) {
				next(error);
			});
		}

		function createSiteUserRoute(req, res, next) {
			var userModel = req.user;
			var username = userModel.username;
			var siteName = req.params.site;
			var siteUserAuthDetails = {
				username: req.body.username,
				password: req.body.password
			};

			new Promise(function(resolve, reject) {
				resolve(
					siteService.createSiteUser(username, siteName, siteUserAuthDetails, siteAuthOptions)
						.then(function(userModel) {
							res.redirect(303, '/canvases/' + siteName + '/users');
						})
				);
			})
			.catch(function(error) {
				next(error);
			});
		}

		function updateSiteUserRoute(req, res, next) {
			var userModel = req.user;
			var username = userModel.username;
			var siteName = req.params.site;
			var siteUsername = req.params.username;
			var siteUserAuthDetails = {
				username: req.params.username,
				password: req.body.password
			};

			new Promise(function(resolve, reject) {
				resolve(
					siteService.updateSiteUser(username, siteName, siteUsername, siteUserAuthDetails, siteAuthOptions)
						.then(function(userModel) {
							res.redirect(303, '/canvases/' + siteName + '/users');
						})
				);
			})
			.catch(function(error) {
				next(error);
			});
		}

		function deleteSiteUserRoute(req, res, next) {
			var userModel = req.user;
			var username = userModel.username;
			var siteName = req.params.site;
			var siteUsername = req.params.username;

			new Promise(function(resolve, reject) {
				resolve(
					siteService.deleteSiteUser(username, siteName, siteUsername)
						.then(function() {
							res.redirect(303, '/canvases/' + siteName + '/users');
						})
				);
			})
			.catch(function(error) {
				next(error);
			});
		}

		function retrieveSiteEditRoute(req, res, next) {
			var userModel = req.user;
			var username = userModel.username;
			var userAdapters = req.user.adapters;
			var siteName = req.params.site;

			new Promise(function(resolve, reject) {
				var includeTheme = true;
				var includeContents = false;
				var includeUsers = false;
				resolve(
					siteService.retrieveSite(username, siteName, {
						theme: includeTheme,
						contents: includeContents,
						users: includeUsers
					})
					.then(function(siteModel) {
						var siteRoot = siteModel.root;
						var siteAdapter = siteRoot.adapter;
						var siteAdapterConfig = siteRoot.config;
						var userAdapterConfig = userAdapters[siteAdapter];
						var adapter = adapters[siteAdapter];
						var adapterUploadConfig = adapter.getUploadConfig(siteAdapterConfig, userAdapterConfig);
						var themeId = siteModel.theme.id;
						var theme = themeService.getTheme(themeId);
						var templateData = {
							content: {
								previewUrl: '/preview/' + siteModel.name,
								site: siteModel,
								themes: themeService.getThemes(),
								theme: theme,
								adapter: adapterUploadConfig
							}
						};
						return adminPageService.render(req, res, {
							template: 'sites/site/edit',
							context: templateData
						});
					})
				);
			})
			.catch(function(error) {
				next(error);
			});
		}

		function prefixUserUploadPath(param) {
			return function(req, res, next) {
				var filename = (param ? req.params[param] : req.params[0]);
				if (!filename) { return next(new HttpError(403)); }
				var userModel = req.user;
				var username = userModel.username;
				req.params.filename = username + '/' + filename;
				next();
			};
		}
	}
};
