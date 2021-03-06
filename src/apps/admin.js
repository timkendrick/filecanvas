'use strict';

var assert = require('assert');
var objectAssign = require('object-assign');
var express = require('express');
var Passport = require('passport').Passport;
var composeMiddleware = require('compose-middleware').compose;

var faqApp = require('./admin/faq');
var supportApp = require('./admin/support');
var accountApp = require('./admin/account');
var sitesApp = require('./admin/sites');
var previewApp = require('./admin/preview');
var adaptersApp = require('./admin/adapters');
var templatesApp = require('./admin/templates');
var loginApp = require('./admin/login');

var session = require('../middleware/session');
var forms = require('../middleware/forms');
var sessionState = require('../middleware/sessionState');
var redirect = require('../middleware/redirect');
var invalidRoute = require('../middleware/invalidRoute');

var handlebarsEngine = require('../engines/handlebars');

var loadLoginAdapters = require('../utils/loadLoginAdapters');
var loadStorageAdapters = require('../utils/loadStorageAdapters');
var loadUploadAdapter = require('../utils/loadUploadAdapter');
var stripTrailingSlash = require('../utils/stripTrailingSlash');
var appendQueryParams = require('../utils/appendQueryParams');
var parseLocation = require('../utils/parseLocation');
var getSubdomainUrl = require('../utils/getSubdomainUrl');

var LoginService = require('../services/LoginService');
var UserService = require('../services/UserService');

module.exports = function(database, cache, options) {
	options = options || {};
	var host = options.host;
	var cookieSecret = options.cookieSecret;
	var sessionStore = options.sessionStore;
	var sessionDuration = options.sessionDuration;
	var templatesPath = options.templatesPath;
	var partialsPath = options.partialsPath;
	var themesPath = options.themesPath;
	var faqPath = options.faqPath;
	var siteTemplatePath = options.siteTemplatePath;
	var adminAssetsUrl = options.adminAssetsUrl;
	var themesUrl = options.themesUrl;
	var themeAssetsUrl = options.themeAssetsUrl;
	var wwwUrl = options.wwwUrl;
	var adaptersConfig = options.adapters;
	var siteAuthOptions = options.siteAuth;
	var uploadAdapterConfig = options.uploadAdapter;
	var analyticsConfig = options.analytics;

	assert(database, 'Missing database');
	assert(cache, 'Missing key-value store');
	assert(host, 'Missing host details');
	assert(cookieSecret, 'Missing cookie secret');
	assert(sessionStore, 'Missing session store URL');
	assert(sessionDuration, 'Missing session duration');
	assert(templatesPath, 'Missing templates path');
	assert(partialsPath, 'Missing partials path');
	assert(themesPath, 'Missing themes path');
	assert(faqPath, 'Missing FAQ path');
	assert(siteTemplatePath, 'Missing site template path');
	assert(adminAssetsUrl, 'Missing admin asset root URL');
	assert(themesUrl, 'Missing themes URL');
	assert(themeAssetsUrl, 'Missing theme assets URL');
	assert(wwwUrl, 'Missing www URL');
	assert(adaptersConfig, 'Missing adapters configuration');
	assert(siteAuthOptions, 'Missing site authentication options');
	assert(uploadAdapterConfig, 'Missing upload adapter configuration');
	assert(analyticsConfig, 'Missing analytics configuration');

	var loginAdapters = loadLoginAdapters(adaptersConfig);
	var storageAdapters = loadStorageAdapters(adaptersConfig, database, cache);
	var uploadAdapter = loadUploadAdapter(uploadAdapterConfig);

	var userService = new UserService(database);

	var app = express();
	app.use(session({
		cookieSecret: cookieSecret,
		store: sessionStore,
		ttl: sessionDuration
	}));
	app.use(forms());
	app.use(sessionState());

	initAuth(app, database, {
		templatesPath: templatesPath,
		partialsPath: partialsPath,
		adapters: loginAdapters,
		sessionMiddleware: initAdminSession,
		analytics: analyticsConfig
	});
	initHome(app, {
		redirect: '/canvases'
	});
	initFaq(app, {
		templatesPath: templatesPath,
		partialsPath: partialsPath,
		faqPath: faqPath,
		sessionMiddleware: initAdminSession,
		analytics: analyticsConfig
	});
	initSupport(app, {
		templatesPath: templatesPath,
		partialsPath: partialsPath,
		sessionMiddleware: initAdminSession,
		analytics: analyticsConfig
	});
	initAccount(app, database, {
		templatesPath: templatesPath,
		partialsPath: partialsPath,
		adapters: loginAdapters,
		sessionMiddleware: initAdminSession,
		analytics: analyticsConfig
	});
	initSites(app, database, {
		host: host,
		templatesPath: templatesPath,
		partialsPath: partialsPath,
		themesPath: themesPath,
		siteTemplatePath: siteTemplatePath,
		siteAuthOptions: siteAuthOptions,
		adminAssetsUrl: adminAssetsUrl,
		themesUrl: themesUrl,
		adapters: storageAdapters,
		uploadAdapter: uploadAdapter,
		sessionMiddleware: initAdminSession,
		analytics: analyticsConfig
	});
	initPreview(app, database, cache, {
		host: host,
		themesPath: themesPath,
		themesUrl: themesUrl,
		themeAssetsUrl: themeAssetsUrl,
		adaptersConfig: adaptersConfig,
		analytics: analyticsConfig
	});
	initTemplates(app, {
		templatesPath: templatesPath,
		partialsPath: partialsPath
	});
	initAdapters(app, database, {
		host: host,
		adapters: storageAdapters,
		sessionMiddleware: initAdminSession
	});
	initErrorHandler(app);
	initViewEngine(app, {
		templatesPath: templatesPath
	});

	return app;


	function initHome(app, options) {
		options = options || {};
		var redirectUrl = options.redirect;

		app.get('/', ensureAuth('/login'), redirect(redirectUrl));
	}

	function initFaq(app, options) {
		options = options || {};
		var templatesPath = options.templatesPath;
		var partialsPath = options.partialsPath;
		var faqPath = options.faqPath;
		var sessionMiddleware = options.sessionMiddleware;
		var analyticsConfig = options.analytics;

		app.use('/faq', composeMiddleware([
			ensureAuth('/login'),
			faqApp({
				templatesPath: templatesPath,
				partialsPath: partialsPath,
				faqPath: faqPath,
				sessionMiddleware: sessionMiddleware,
				analytics: analyticsConfig
			})
		]));
	}

	function initSupport(app, options) {
		options = options || {};
		var templatesPath = options.templatesPath;
		var partialsPath = options.partialsPath;
		var sessionMiddleware = options.sessionMiddleware;
		var analyticsConfig = options.analytics;

		app.use('/support', composeMiddleware([
			ensureAuth('/login'),
			supportApp({
				templatesPath: templatesPath,
				partialsPath: partialsPath,
				sessionMiddleware: sessionMiddleware,
				analytics: analyticsConfig
			})
		]));
	}

	function initAccount(app, database, options) {
		options = options || {};
		var templatesPath = options.templatesPath;
		var partialsPath = options.partialsPath;
		var sessionMiddleware = options.sessionMiddleware;
		var adapters = options.adapters;
		var analyticsConfig = options.analytics;

		app.use('/account', composeMiddleware([
			ensureAuth('/login'),
			accountApp(database, {
				templatesPath: templatesPath,
				partialsPath: partialsPath,
				adapters: adapters,
				sessionMiddleware: sessionMiddleware,
				analytics: analyticsConfig
			})
		]));
	}

	function initTemplates(app, options) {
		options = options || {};
		var templatesPath = options.templatesPath;
		var partialsPath = options.partialsPath;

		app.use('/templates', templatesApp({
			templatesPath: templatesPath,
			partialsPath: partialsPath
		}));
	}

	function initSites(app, database, options) {
		options = options || {};
		var host = options.host;
		var templatesPath = options.templatesPath;
		var partialsPath = options.partialsPath;
		var themesPath = options.themesPath;
		var siteTemplatePath = options.siteTemplatePath;
		var siteAuthOptions = options.siteAuthOptions;
		var adminAssetsUrl = options.adminAssetsUrl;
		var themesUrl = options.themesUrl;
		var adapters = options.adapters;
		var uploadAdapter = options.uploadAdapter;
		var sessionMiddleware = options.sessionMiddleware;
		var analyticsConfig = options.analytics;

		app.use('/canvases', composeMiddleware([
			ensureAuth('/login'),
			sitesApp(database, {
				host: host,
				templatesPath: templatesPath,
				partialsPath: partialsPath,
				themesPath: themesPath,
				siteTemplatePath: siteTemplatePath,
				siteAuthOptions: siteAuthOptions,
				adminAssetsUrl: adminAssetsUrl,
				themesUrl: themesUrl,
				adapters: adapters,
				uploadAdapter: uploadAdapter,
				sessionMiddleware: sessionMiddleware,
				analytics: analyticsConfig
			})
		]));
	}

	function initPreview(app, database, cache, options) {
		options = options || {};
		var host = options.host;
		var themesPath = options.themesPath;
		var themesUrl = options.themesUrl;
		var themeAssetsUrl = options.themeAssetsUrl;
		var adaptersConfig = options.adaptersConfig;
		var analyticsConfig = options.analytics;

		app.use('/preview', composeMiddleware([
			ensureAuth('/login'),
			previewApp(database, cache, {
				host: host,
				themesPath: themesPath,
				themesUrl: themesUrl,
				themeAssetsUrl: themeAssetsUrl,
				adaptersConfig: adaptersConfig,
				analytics: analyticsConfig
			})
		]));
	}

	function initAdapters(app, database, options) {
		options = options || {};
		var host = options.host;
		var adapters = options.adapters;

		app.use('/adapters', composeMiddleware([
			ensureAuth('/login'),
			adaptersApp(database, {
				host: host,
				adapters: adapters
			})
		]));
	}

	function initAuth(app, database, options) {
		options = options || {};
		var templatesPath = options.templatesPath;
		var partialsPath = options.partialsPath;
		var adapters = options.adapters;
		var sessionMiddleware = options.sessionMiddleware;
		var analyticsConfig = options.analytics;

		var userService = new UserService(database);

		var passport = createPassportInstance(userService);
		app.use(passport.initialize());
		app.use(passport.session());

		var loginMiddleware = createLoginAdaptersMiddleware(database, passport, {
			prefix: '/login',
			adapters: adapters
		});
		var loginErrorHandler = function(err, req, res, next) {
			var isFailedLoginError = (err.status === 401);
			if (isFailedLoginError) {
				var redirectMethod = 'GET';
				var redirectUrl = '/login';
				var redirectQuery = {};
				if (err.code === 'invalid_refresh_token') {
					redirectQuery['reapprove'] = 'true';
				}
				if (err.code) { redirectQuery['error'] = err.code; }
				if (err.description) { redirectQuery['error_description'] = err.description; }
				internalRedirect(req, {
					method: redirectMethod,
					url: redirectUrl,
					query: redirectQuery
				});
				next();
			} else{
				next(err);
			}
		};
		var loginPages = loginApp(database, {
			templatesPath: templatesPath,
			partialsPath: partialsPath,
			adapters: adapters,
			sessionMiddleware: sessionMiddleware,
			analytics: analyticsConfig
		});
		var forceRegisterIfPendingUser = function(req, res, next) {
			if (req.isAuthenticated() && req.user.pending) {
				if (req.url !== '/register') {
					res.redirect('/register');
					return;
				}
			}
			next();
		};

		loginMiddleware.use(loginErrorHandler);
		loginMiddleware.use(loginPages);
		loginMiddleware.use(forceRegisterIfPendingUser);

		app.use(loginMiddleware);


		function createPassportInstance(userService) {
			var passport = new Passport();

			passport.serializeUser(function(userModel, callback) {
				var username = userModel.username;
				callback(null, username);
			});

			passport.deserializeUser(function(req, username, callback) {
				return userService.retrieveUser(username)
					.then(function(userModel) {
						callback(null, userModel);
					})
					.catch(function(error) {
						if (error.status === 404) {
							error.status = 500;
						}
						req.logout();
						callback(error);
					});
			});

			return passport;
		}

		function createLoginAdaptersMiddleware(database, passport, options) {
			options = options || {};
			var adapters = options.adapters;
			var loginPrefix = options.prefix || '';

			var app = express();

			Object.keys(adapters).forEach(function(key) {
				var adapterName = key;
				var adapter = adapters[key];
				app.post(loginPrefix + '/' + adapterName, function(req, res, next) {
					delete req.session.loginRedirect;
					if (req.body.redirect) {
						req.session.loginRedirect = req.body.redirect;
					}
					next();
				});

				var adapterMiddleware = adapter.middleware(passport, authCallback, loginCallback);
				app.use(loginPrefix + '/' + adapterName, adapterMiddleware);


				function authCallback(error, user, info, req, res, next) {
					if (error) { return next(error); }

					loginPassportUser(user, info, req, function(error) {
						if (error) { return next(error); }
						req.session.adapter = adapterName;
						var redirectUrl = req.session.loginRedirect;
						delete req.session.loginRedirect;
						res.redirect(redirectUrl || '/');
					});


					function loginPassportUser(user, info, req, callback) {
						req.logIn(user, function(error) {
							if (error) { return callback(error); }
							passport.transformAuthInfo(info, req, function(error, authInfo) {
								if (error) { return next(error); }
								req.authInfo = authInfo;
								callback(null);
							});
						});
					}
				}

				function loginCallback(req, passportValues, query, next) {
					var loginService = new LoginService(database, adapter);
					loginService.login(query, passportValues, { request: req })
						.then(function(userModel) {
							next(null, userModel);
						})
						.catch(function(error) {
							next(error);
						});
				}
			});

			return app;
		}

		function internalRedirect(req, options) {
			options = options || {};
			var method = options.method || null;
			var url = options.url || null;
			var query = options.query || null;
			var body = options.body || null;
			if (method) { req.method = method; }
			if (url) { req.url = url; }
			req.query = query || {};
			req.body = body || null;
		}
	}

	function initErrorHandler(app) {
		app.use(invalidRoute());
	}

	function initViewEngine(app, options) {
		options = options || {};
		var templatesPath = options.templatesPath;

		app.engine('hbs', handlebarsEngine);
		app.set('views', templatesPath);
		app.set('view engine', 'hbs');
	}

	function ensureAuth(loginUrl) {
		return function(req, res, next) {
			if (req.isAuthenticated()) {
				next();
			} else {
				var redirectUrl = (req.originalUrl === '/' ? null : req.originalUrl);
				var url = (redirectUrl ? appendQueryParams(loginUrl, { redirect: redirectUrl }) : loginUrl);
				res.redirect(url);
			}
		};
	}

	function initAdminSession(req, res, next) {
		loadSessionData(req)
			.then(function(sessionData) {
				Object.keys(sessionData).forEach(function(key) {
					res.locals[key] = sessionData[key];
				});
				next();
			})
			.catch(function(error) {
				next(error);
			});


		function loadSessionData(req) {
			var userModel = req.user || null;

			return Promise.resolve(userModel ? retrieveSortedUserSites(userModel) : null)
				.then(function(sortedSiteModels) {
					var currentSubdomain = (req.subdomains ? req.subdomains.join('.') : null);
					var location = parseLocation(objectAssign({}, host, {
						hostname: (currentSubdomain ? currentSubdomain + '.' : '') + host.hostname,
						path: req.originalUrl
					}));
					var webrootUrl = (userModel ? getSubdomainUrl(userModel.username, { host: host }) : null);
					var domainUrlPattern = getSubdomainUrl('$0', { host: host });
					return {
						location: location,
						urls: {
							root: location.protocol + '//' + location.host,
							webroot: webrootUrl,
							domain: domainUrlPattern,
							home: '/',
							assets: adminAssetsUrl,
							themes: stripTrailingSlash(themesUrl),
							templates: '/templates',
							admin: {
								root: '/',
								faq: '/faq',
								support: '/support',
								account: '/account',
								login: '/login',
								register: '/register',
								logout: '/logout',
								sites: '/canvases',
								sitesCreate: '/canvases/create-canvas',
								sitesCreateThemes: '/canvases/create-canvas/themes',
								preview: '/preview'
							},
							www: {
								root: wwwUrl,
								signup: wwwUrl + '#sign-up',
								security: stripTrailingSlash(wwwUrl) + '/security',
								terms: stripTrailingSlash(wwwUrl) + '/terms',
								privacy: stripTrailingSlash(wwwUrl) + '/privacy'
							}
						},
						sites: sortedSiteModels
					};
				});


			function retrieveSortedUserSites(userModel) {
				return userService.retrieveUserSites(userModel.username)
					.then(function(siteModels) {
						var defaultSiteName = userModel.defaultSite;
						return getSortedSiteModels(siteModels, defaultSiteName);
					});


				function getSortedSiteModels(siteModels, defaultSiteName) {
					return siteModels.slice().sort(function(item1, item2) {
						if (item1.name === defaultSiteName) { return -1; }
						if (item2.name === defaultSiteName) { return 1; }
						return (item1.label < item2.label ? -1 : 1);
					});
				}
			}
		}
	}
};
