'use strict';

var express = require('express');
var merge = require('lodash.merge');
var isUrl = require('is-url');

var handlebarsEngine = require('../../engines/handlebars');

var readDirContentsSync = require('../../utils/readDirContentsSync');
var expandConfigPlaceholders = require('../../utils/expandConfigPlaceholders');

var HttpError = require('../../errors/HttpError');

var UserService = require('../../services/UserService');
var SiteService = require('../../services/SiteService');
var ThemeService = require('../../services/ThemeService');
var AdminPageService = require('../../services/AdminPageService');

module.exports = function(database, options) {
	options = options || {};
	var host = options.host || null;
	var templatesPath = options.templatesPath || null;
	var partialsPath = options.partialsPath || null;
	var themesPath = options.themesPath || null;
	var siteTemplatePath = options.siteTemplatePath || null;
	var siteAuthOptions = options.siteAuthOptions || null;
	var themeAssetsUrl = options.themeAssetsUrl || null;
	var adminAssetsUrl = options.adminAssetsUrl || null;
	var themesUrl = options.themesUrl || null;
	var adapters = options.adapters || null;
	var sessionMiddleware = options.sessionMiddleware || null;

	if (!host) { throw new Error('Missing host name'); }
	if (!templatesPath) { throw new Error('Missing templates path'); }
	if (!partialsPath) { throw new Error('Missing partials path'); }
	if (!themesPath) { throw new Error('Missing themes path'); }
	if (!siteTemplatePath) { throw new Error('Missing site template path'); }
	if (!siteAuthOptions) { throw new Error('Missing site auth options'); }
	if (!themeAssetsUrl) { throw new Error('Missing theme assets URL'); }
	if (!adminAssetsUrl) { throw new Error('Missing admin assets URL'); }
	if (!themesUrl) { throw new Error('Missing theme gallery URL'); }
	if (!adapters) { throw new Error('Missing adapters'); }
	if (!sessionMiddleware) { throw new Error('Missing session middleware'); }

	var siteTemplateFiles = readDirContentsSync(siteTemplatePath);

	var userService = new UserService(database);
	var siteService = new SiteService(database, {
		host: host,
		adapters: adapters
	});
	var themeService = new ThemeService({
		themesPath: themesPath
	});
	var adminPageService = new AdminPageService({
		templatesPath: templatesPath,
		partialsPath: partialsPath
	});

	var app = express();

	initRoutes(app, sessionMiddleware);

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

	function initRoutes(app, sessionMiddleware) {
		app.get('/', sessionMiddleware, retrieveSitesRoute);
		app.post('/', sessionMiddleware, createSiteRoute);
		app.get('/create-site', sessionMiddleware, retrieveCreateSiteRoute);
		app.get('/create-site/themes', sessionMiddleware, retrieveCreateSiteThemesRoute);
		app.get('/create-site/themes/:theme', sessionMiddleware, retrieveCreateSiteThemeRoute);
		app.get('/:site', sessionMiddleware, retrieveSiteRoute);
		app.put('/:site', sessionMiddleware, updateSiteRoute);
		app.delete('/:site', sessionMiddleware, deleteSiteRoute);

		app.get('/:site/users', sessionMiddleware, retrieveSiteUsersRoute);
		app.post('/:site/users', sessionMiddleware, createSiteUserRoute);
		app.put('/:site/users/:username', sessionMiddleware, updateSiteUserRoute);
		app.delete('/:site/users/:username', sessionMiddleware, deleteSiteUserRoute);

		app.get('/:site/edit', sessionMiddleware, retrieveSiteEditRoute);


		function retrieveSitesRoute(req, res, next) {
			new Promise(function(resolve, reject) {
				var templateData = {
					title: 'Site dashboard',
					navigation: true,
					footer: true,
					breadcrumb: [
						{
							link: '/sites',
							icon: 'dashboard',
							label: 'Site dashboard'
						}
					],
					content: {
						sites: res.locals.sites,
						themes: themeService.getThemes()
					}
				};
				return resolve(
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
					var adapterConfig = userAdapters[adapterName];
					adaptersMetadata[adapterName] = adapter.getMetadata(adapterConfig);
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
					title: 'Site dashboard',
					navigation: true,
					footer: true,
					breadcrumb: [
						{
							link: '/sites',
							icon: 'dashboard',
							label: 'Site dashboard'
						},
						{
							link: '/sites/create-site',
							icon: 'plus',
							label: 'Create a site'
						}
					],
					content: {
						site: siteModel,
						themes: themeService.getThemes(),
						adapters: adaptersMetadata
					}
				};
				return resolve(
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
			var themes = themeService.getThemes();
			var themeIds = Object.keys(themes);
			var firstThemeId = themeIds[0];
			res.redirect('/sites/create-site/themes/' + firstThemeId);
		}

		function retrieveCreateSiteThemeRoute(req, res, next) {
			var themeId = req.params.theme;
			new Promise(function(resolve, reject) {
				var themes = themeService.getThemes();
				var theme = themeService.getTheme(themeId);
				var previousTheme = themeService.getPreviousTheme(themeId);
				var nextTheme = themeService.getNextTheme(themeId);
				var templateData = {
					title: 'Theme gallery',
					fullPage: true,
					navigation: false,
					footer: false,
					breadcrumb: [
						{
							link: '/sites',
							icon: 'dashboard',
							label: 'Site dashboard'
						},
						{
							link: '/sites/create-site',
							icon: 'plus',
							label: 'Create a site'
						},
						{
							link: '/sites/create-site/themes',
							icon: 'image',
							label: 'Theme gallery'
						},
						{
							link: '/sites/create-site/themes/' + theme.id,
							icon: null,
							label: theme.name
						}
					],
					content: {
						themes: themes,
						theme: theme,
						previousTheme: previousTheme,
						nextTheme: nextTheme
					}
				};
				return resolve(
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
			var redirectUrl = req.body['_redirect'] || ('/sites/' + req.body.name);

			var isDefaultSite = (req.body.home === 'true');
			var isPrivate = (req.body.private === 'true');
			var isPublished = (req.body.published === 'true');

			var themeId = req.body.theme && req.body.theme.id || null;
			var themeConfig = req.body.theme && req.body.theme.config || null;
			if (typeof themeConfig === 'string') {
				try {
					themeConfig = JSON.parse(themeConfig);
				} catch(error) {
					return next(new HttpError(401));
				}
			}

			new Promise(function(resolve, reject) {
				var siteModel = {
					'owner': username,
					'name': req.body.name,
					'label': req.body.label,
					'theme': {
						'id': themeId,
						'config': null
					},
					'root': req.body.root || null,
					'private': isPrivate,
					'users': [],
					'published': isPublished,
					'cache': null
				};

				var theme = themeService.getTheme(themeId);
				var defaultThemeConfig = expandConfigPlaceholders(theme.defaults, {
					site: {
						label: siteModel.label
					}
				});
				siteModel.theme.config = merge({}, defaultThemeConfig, themeConfig);

				return resolve(
					siteService.createSite(siteModel, siteTemplateFiles)
						.then(function(siteModel) {
							if (!isDefaultSite) { return siteModel; }
							return userService.updateUserDefaultSiteName(username, siteModel.name)
								.then(function() {
									return siteModel;
								});
						})
						.then(function(siteModel) {
							res.redirect(303, redirectUrl);
						})
				);
			})
			.catch(function(error) {
				next(error);
			});
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
					var adapterConfig = userAdapters[adapterName];
					adaptersMetadata[adapterName] = adapter.getMetadata(adapterConfig);
					return adaptersMetadata;
				}, {});
				var includeTheme = false;
				var includeContents = false;
				var includeUsers = true;
				return resolve(
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
								title: 'Site settings: ' + siteModel.label,
								navigation: true,
								footer: true,
								breadcrumb: [
									{
										link: '/sites',
										icon: 'dashboard',
										label: 'Site dashboard'
									},
									{
										link: '/sites/' + siteName,
										icon: 'globe',
										label: siteModel.label
									}
								],
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
				return resolve(
					siteService.updateSite(username, siteName, updates)
						.then(function() {
							var updatedDefaultSiteName = (isUpdatedDefaultSite ? updatedSiteName : (isDefaultSite ? null : defaultSiteName));
							if (updatedDefaultSiteName === defaultSiteName) { return; }
							return userService.updateUserDefaultSiteName(username, updatedDefaultSiteName);
						})
						.then(function() {
							res.redirect(303, '/sites/' + updatedSiteName);
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
			var cache = null;

			new Promise(function(resolve, reject) {
				return resolve(
					siteService.updateSiteCache(username, siteName, cache)
						.then(function() {
							res.redirect(303, '/sites/' + siteName);
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
				return resolve(
					siteService.deleteSite(username, siteName)
						.then(function(siteModel) {
							res.redirect(303, '/sites');
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
			var includeTheme = false;
			var includeContents = false;
			var includeUsers = true;

			new Promise(function(resolve, reject) {
				return resolve(
					siteService.retrieveSite(username, siteName, {
						theme: includeTheme,
						contents: includeContents,
						users: includeUsers
					})
					.then(function(siteModel) {
						var templateData = {
							title: 'Edit site users: ' + siteModel.label,
							navigation: true,
							footer: true,
							breadcrumb: [
								{
									link: '/sites',
									icon: 'dashboard',
									label: 'Site dashboard'
								},
								{
									link: '/sites/' + siteName,
									icon: 'globe',
									label: siteModel.label
								},
								{
									link: '/sites/' + siteName + '/users',
									icon: 'users',
									label: 'Site users'
								}
							],
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
				return resolve(
					siteService.createSiteUser(username, siteName, siteUserAuthDetails, siteAuthOptions)
						.then(function(userModel) {
							res.redirect(303, '/sites/' + siteName + '/users');
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
				return resolve(
					siteService.updateSiteUser(username, siteName, siteUsername, siteUserAuthDetails, siteAuthOptions)
						.then(function(userModel) {
							res.redirect(303, '/sites/' + siteName + '/users');
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
				return resolve(
					siteService.deleteSiteUser(username, siteName, siteUsername)
						.then(function() {
							res.redirect(303, '/sites/' + siteName + '/users');
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
			var includeTheme = true;
			var includeContents = false;
			var includeUsers = false;

			new Promise(function(resolve, reject) {
				return resolve(
					siteService.retrieveSite(username, siteName, {
						theme: includeTheme,
						contents: includeContents,
						users: includeUsers
					})
					.then(function(siteModel) {
						var siteAdapter = siteModel.root.adapter;
						var sitePath = siteModel.root.path;
						var adapterOptions = userAdapters[siteAdapter];
						var adapter = adapters[siteAdapter];
						var adapterConfig = adapter.getUploadConfig(sitePath, adapterOptions);
						var themeId = siteModel.theme.id;
						var theme = themeService.getTheme(themeId);
						var themeAssetsRoot = themeAssetsUrl + themeId + '/';
						var templateData = {
							title: 'Site editor',
							stylesheets: [
								'//cdnjs.cloudflare.com/ajax/libs/bootstrap-select/1.7.5/css/bootstrap-select.min.css',
								adminAssetsUrl + 'css/bootstrap-colorpicker.min.css',
								adminAssetsUrl + 'css/shunt-editor.css'
							],
							scripts: [
								'//cdnjs.cloudflare.com/ajax/libs/bootstrap-select/1.7.5/js/bootstrap-select.min.js',
								adminAssetsUrl + 'js/bootstrap-colorpicker.min.js',
								adminAssetsUrl + 'js/shunt-editor.js',
								'/templates/partials/theme-options.js',
								themesUrl + themeId + '/template/index.js'
							],
							fullPage: true,
							navigation: false,
							footer: false,
							breadcrumb: [
								{
									link: '/sites',
									icon: 'dashboard',
									label: 'Site dashboard'
								},
								{
									link: '/sites/' + siteName,
									icon: 'globe',
									label: siteModel.label
								},
								{
									link: '/sites/' + siteName + '/theme',
									icon: 'paint-brush',
									label: 'Site editor'
								}
							],
							content: {
								previewUrl: '/preview/' + siteModel.name,
								site: siteModel,
								themes: themeService.getThemes(),
								adapter: adapterConfig
							}
						};
						if (theme.fonts) {
							var fontsStylesheetUrl = isUrl(theme.fonts) ? theme.fonts : themeAssetsRoot + theme.fonts;
							templateData.stylesheets.push(fontsStylesheetUrl);
						}
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
	}
};
