'use strict';

var path = require('path');
var merge = require('lodash.merge');
var express = require('express');
var cors = require('cors');
var isUrl = require('is-url');

var constants = require('../constants');

var thumbnailer = require('../middleware/thumbnailer');
var invalidRoute = require('../middleware/invalidRoute');
var errorHandler = require('../middleware/errorHandler');

var stripTrailingSlash = require('../utils/stripTrailingSlash');

var handlebarsEngine = require('../engines/handlebars');

var AdminPageService = require('../services/AdminPageService');
var ThemeService = require('../services/ThemeService');

var THEME_MANIFEST_PATH = constants.THEME_MANIFEST_PATH;
var THEME_PREVIEW_FILES_PATH = constants.THEME_PREVIEW_FILES_PATH;

module.exports = function(options) {
	options = options || {};
	var host = options.host;
	var templatesPath = options.templatesPath;
	var partialsPath = options.partialsPath;
	var errorTemplatesPath = options.errorTemplatesPath;
	var themesPath = options.themesPath;
	var themeAssetsUrl = options.themeAssetsUrl;
	var thumbnailsPath = options.thumbnailsPath;
	var thumbnailWidth = options.thumbnailWidth;
	var thumbnailHeight = options.thumbnailHeight;
	var thumbnailFormat = options.thumbnailFormat;
	var adminAssetsUrl = options.adminAssetsUrl;
	var adminTemplatesUrl = options.adminTemplatesUrl;
	var createSiteUrl = options.createSiteUrl;

	if (!host) { throw new Error('Missing host name'); }
	if (!templatesPath) { throw new Error('Missing templates path'); }
	if (!partialsPath) { throw new Error('Missing partials path'); }
	if (!errorTemplatesPath) { throw new Error('Missing error templates path'); }
	if (!themesPath) { throw new Error('Missing themes path'); }
	if (!themeAssetsUrl) { throw new Error('Missing theme asset root URL'); }
	if (!thumbnailsPath) { throw new Error('Missing thumbnails path'); }
	if (!thumbnailWidth) { throw new Error('Missing thumbnail width'); }
	if (!thumbnailHeight) { throw new Error('Missing thumbnail height'); }
	if (!adminAssetsUrl) { throw new Error('Missing admin asset root URL'); }
	if (!adminTemplatesUrl) { throw new Error('Missing admin templates URL'); }
	if (!createSiteUrl) { throw new Error('Missing create site URL'); }

	var themeService = new ThemeService({
		themesPath: themesPath
	});
	var adminPageService = new AdminPageService({
		templatesPath: templatesPath,
		partialsPath: partialsPath
	});

	var app = express();

	app.use(cors({
		origin: new RegExp('^https?://\\w+\\.' + host + '(?::\\d+)?$')
	}));

	initViewEngine(app, {
		templatesPath: templatesPath
	});
	initRoutes(app, {
		themesPath: themesPath,
		themeAssetsUrl: themeAssetsUrl,
		thumbnailsPath: thumbnailsPath,
		thumbnailWidth: thumbnailWidth,
		thumbnailHeight: thumbnailHeight,
		thumbnailFormat: thumbnailFormat
	});
	initErrorHandler(app, {
		templatesPath: errorTemplatesPath,
		template: 'error'
	});

	return app;


	function initViewEngine(app, options) {
		options = options || {};
		var templatesPath = options.templatesPath;

		app.engine('hbs', handlebarsEngine);

		app.set('views', templatesPath);
		app.set('view engine', 'hbs');
	}

	function initErrorHandler(app, options) {
		options = options || {};
		var template = options.template;
		var templatesPath = options.templatesPath;

		app.use(invalidRoute());
		app.use(errorHandler({
			templatesPath: templatesPath,
			template: template
		}));
	}

	function initRoutes(app, options) {
		var themesPath = options.themesPath;
		var thumbnailsPath = options.thumbnailsPath;
		var thumbnailWidth = options.thumbnailWidth;
		var thumbnailHeight = options.thumbnailHeight;
		var thumbnailFormat = options.thumbnailFormat;

		var staticServer = express.static(path.resolve(themesPath));

		app.get('/', retrieveThemesRoute);
		app.get('/:theme', retrieveThemeRoute);
		app.get('/:theme/preview', retrieveThemePreviewRoute);
		app.get('/:theme/edit', retrieveThemeEditRoute);
		app.get('/:theme/thumbnail/*', rewritePreviewThumbnailRequest, thumbnailer(themesPath, {
			width: thumbnailWidth,
			height: thumbnailHeight,
			format: thumbnailFormat,
			cache: thumbnailsPath
		}));
		app.get('/:theme/download/*', rewritePreviewDownloadRequest, staticServer);
		app.get('/:theme/metadata', rewriteManifestRequest, staticServer);
		app.get('/:theme/metadata/defaults', retrieveThemeDefaultsRoute);
		app.get('/:theme/metadata/thumbnail', rewriteThumbnailRequest, staticServer);
		app.get('/:theme/template/:template.js', retrievePrecompiledTemplateRoute);


		return app;


		function retrieveThemesRoute(req, res, next) {
			var themeIds = Object.keys(themeService.getThemes());
			var firstThemeId = themeIds[0];
			try {
				res.redirect('/' + firstThemeId);
			} catch (error) {
				next(error);
			}
		}

		function retrieveThemeRoute(req, res, next) {
			var themeId = req.params.theme;

			new Promise(function(resolve, reject) {
				var themes = themeService.getThemes();
				var theme = themeService.getTheme(themeId);
				var previousTheme = themeService.getPreviousTheme(themeId);
				var nextTheme = themeService.getNextTheme(themeId);
				var templateData = {
					title: 'Theme gallery',
					fullPage: true,
					content: {
						themes: themes,
						theme: theme,
						previousTheme: previousTheme,
						nextTheme: nextTheme
					}
				};
				res.locals.urls = {
					assets: adminAssetsUrl
				};
				return adminPageService.render(req, res, {
					template: 'theme',
					context: templateData
				});
			}).catch(function(error) {
				next(error);
			});
		}

		function retrieveThemePreviewRoute(req, res, next) {
			var themeId = req.params.theme;

			new Promise(function(resolve, reject) {
				var theme = themeService.getTheme(themeId);
				var templateData = {
					metadata: {
						siteRoot: '/' + themeId + '/',
						themeRoot: themeAssetsUrl + themeId + '/',
						theme: {
							id: themeId,
							config: theme.preview.config
						}
					},
					resource: {
						private: false,
						root: theme.preview.files
					}
				};
				var templateId = 'index';
				renderTemplate(res, themeId, templateId, templateData, next);
			}).catch(function(error) {
				next(error);
			});
		}

		function retrieveThemeEditRoute(req, res, next) {
			var themeId = req.params.theme;

			new Promise(function(resolve, reject) {
				var theme = themeService.getTheme(themeId);
				var themeAssetsRoot = themeAssetsUrl + themeId + '/';
				var siteModel = {
					name: null,
					label: null,
					theme: {
						id: themeId,
						config: merge({}, theme.preview.config)
					},
					root: null,
					private: false,
					published: false
				};
				var templateData = {
					title: 'Theme editor',
					stylesheets: [
						'//cdnjs.cloudflare.com/ajax/libs/bootstrap-select/1.7.5/css/bootstrap-select.min.css',
						adminAssetsUrl + 'css/bootstrap-colorpicker.min.css',
						adminAssetsUrl + 'css/shunt-editor.css'
					],
					scripts: [
						'//cdnjs.cloudflare.com/ajax/libs/bootstrap-select/1.7.5/js/bootstrap-select.min.js',
						adminAssetsUrl + 'js/bootstrap-colorpicker.min.js',
						adminAssetsUrl + 'js/shunt-editor.js',
						adminTemplatesUrl + 'partials/theme-options.js',
						'/' + themeId + '/template/index.js'
					],
					fullPage: true,
					navigation: false,
					footer: false,
					content: {
						site: siteModel,
						themes: themeService.getThemes(),
						adapter: null,
						preview: {
							metadata: {
								siteRoot: '/' + themeId + '/',
								themeRoot: themeAssetsRoot,
								theme: siteModel.theme,
								preview: true,
								admin: false
							},
							resource: {
								private: false,
								root: theme.preview.files
							}
						}
					}
				};
				if (theme.fonts) {
					var fontsStylesheetUrl = isUrl(theme.fonts) ? theme.fonts : themeAssetsRoot + theme.fonts;
					templateData.stylesheets.push(fontsStylesheetUrl);
				}
				res.locals.urls = {
					assets: adminAssetsUrl,
					createSite: createSiteUrl,
					preview: '/' + themeId + '/preview',
					themes: '',
					themeAssets: stripTrailingSlash(themeAssetsUrl)
				};
				return adminPageService.render(req, res, {
					template: 'theme/edit',
					context: templateData
				});
			})
			.catch(function(error) {
				next(error);
			});
		}

		function retrieveThemeDefaultsRoute(req, res, next) {
			var themeId = req.params.theme;
			try {
				var theme = themeService.getTheme(themeId);
				res.json(theme.defaults);
			} catch (error) {
				next(error);
			}
		}

		function rewritePreviewThumbnailRequest(req, res, next) {
			var themeId = req.params.theme;
			var imagePath = req.params[0];
			try {
				req.url = '/' + themeId + '/' + THEME_PREVIEW_FILES_PATH + '/' + imagePath;
				next();
			} catch (error) {
				next(error);
			}
		}

		function rewritePreviewDownloadRequest(req, res, next) {
			var themeId = req.params.theme;
			var filePath = req.params[0];
			try {
				req.url = '/' + themeId + '/' + THEME_PREVIEW_FILES_PATH + '/' + filePath;
				next();
			} catch (error) {
				next(error);
			}
		}

		function rewriteManifestRequest(req, res, next) {
			var themeId = req.params.theme;
			try {
				req.url = '/' + themeId + '/' + THEME_MANIFEST_PATH;
				next();
			} catch (error) {
				next(error);
			}
		}

		function rewriteThumbnailRequest(req, res, next) {
			var themeId = req.params.theme;
			try {
				var theme = themeService.getTheme(themeId);
				var thumbnailPath = theme.thumbnail;
				req.url = '/' + themeId + '/' + thumbnailPath;
				next();
			} catch (error) {
				next(error);
			}
		}

		function retrievePrecompiledTemplateRoute(req, res, next) {
			var themeId = req.params.theme;
			var templateId = req.params.template;
			new Promise(function(resolve, reject) {
				resolve(
					themeService.serializeThemeTemplate(themeId, templateId)
						.then(function(serializedTemplate) {
							sendPrecompiledTemplate(res, serializedTemplate);
						})
				);
			})
			.catch(function(error) {
				return next(error);
			});
		}

		function renderTemplate(res, themeId, templateId, context, next) {
			res.format({
				'text/html': function() {
					Promise.resolve(
						themeService.renderThemeTemplate(themeId, templateId, context)
					)
					.then(function(output) {
						res.send(output);
					})
					.catch(function(error) {
						next(error);
					});
				},
				'application/json': function() {
					res.json(context);
				}
			});
		}

		function sendPrecompiledTemplate(res, template) {
			res.set('Content-Type', 'text/javscript');
			res.send(template);
		}
	}
};
