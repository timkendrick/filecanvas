'use strict';

var path = require('path');
var express = require('express');
var Passport = require('passport').Passport;
var LocalStrategy = require('passport-local').Strategy;
var merge = require('lodash.merge');

var transport = require('../middleware/transport');
var invalidRoute = require('../middleware/invalidRoute');
var errorHandler = require('../middleware/errorHandler');

var handlebarsEngine = require('../engines/handlebars');

var HttpError = require('../errors/HttpError');

var UserService = require('../services/UserService');
var SiteService = require('../services/SiteService');
var AuthenticationService = require('../services/AuthenticationService');

module.exports = function(database, options) {
	options = options || {};
	var host = options.host;
	var appKey = options.appKey;
	var appSecret = options.appSecret;
	var themesUrl = options.themesUrl;
	var isPreview = options.preview;
	var siteAuthOptions = options.siteAuth;

	if (!host) { throw new Error('Missing hostname'); }
	if (!appKey) { throw new Error('Missing Dropbox app key'); }
	if (!appSecret) { throw new Error('Missing Dropbox app secret'); }
	if (!themesUrl) { throw new Error('Missing themes root URL'); }
	if (!isPreview && !siteAuthOptions) { throw new Error('Missing site authentication options'); }

	var siteService = new SiteService(database, {
		host: host,
		appKey: appKey,
		appSecret: appSecret
	});
	var userService = new UserService(database);

	var app = express();
	var passport = new Passport();

	if (!isPreview) {
		initAuth(app, passport, database);
	}
	initViewEngine(app, {
		templatesPath: path.resolve(__dirname, '../../templates/themes')
	});
	initRoutes(app, passport, database, {
		themesUrl: themesUrl,
		preview: isPreview
	});
	initErrorHandler(app, {
		template: 'error'
	});

	return app;


	function initAuth(app, passport, database) {
		app.use(transport());
		app.use(passport.initialize());
		app.use(passport.session());

		passport.serializeUser(function(passportUser, callback) {
			var serializedUser = JSON.stringify({
				user: passportUser.user,
				site: passportUser.site,
				siteUser: (passportUser.model ? passportUser.model.username : null)
			});
			return callback(null, serializedUser);
		});

		passport.deserializeUser(function(serializedUser, callback) {
			var deserializedUser = JSON.parse(serializedUser);
			var username = deserializedUser.user;
			var siteName = deserializedUser.site;
			var siteUsername = deserializedUser.siteUser;

			siteService.retrieveSiteAuthenticationDetails(username, siteName, {
				published: true
			})
				.then(function(authenticationDetails) {
					var isPrivate = authenticationDetails.private;
					if (!isPrivate) {
						var anonymousUser = {
							user: username,
							site: siteName,
							model: null
						};
						return callback(null, anonymousUser);
					}
					var validUsers = authenticationDetails.users;
					var matchedUsers = validUsers.filter(function(validUser) {
						return validUser.username === siteUsername;
					});

					if (matchedUsers.length === 0) {
						throw new Error('Username not found: "' + siteUsername + '"');
					}

					var siteUserModel = matchedUsers[0];
					var passportUser = {
						user: username,
						site: siteName,
						model: siteUserModel
					};
					return callback(null, passportUser);
				})
				.catch(function(error) {
					return callback(error);
				});
		});

		passport.use('site/local', new LocalStrategy({ passReqToCallback: true },
			function(req, siteUsername, sitePassword, callback) {
				var username = req.params.user;
				var siteName = req.params.site;

				siteService.retrieveSiteAuthenticationDetails(username, siteName, {
					published: true
				})
					.then(function(authenticationDetails) {
						var isPrivate = authenticationDetails.private;
						if (!isPrivate) {
							var passportUser = {
								user: username,
								site: siteName,
								model: null
							};
							return callback(null, passportUser);
						}

						var validUsers = authenticationDetails.users;
						var authenticationService = new AuthenticationService(siteAuthOptions);
						return authenticationService.authenticate(siteUsername, sitePassword, validUsers)
							.then(function(siteUserModel) {
								if (!siteUserModel) { return callback(null, false); }

								var passportUser = {
									user: username,
									site: siteName,
									model: siteUserModel
								};
								return callback(null, passportUser);
							});
					})
					.catch(function(error) {
						return callback(error);
					});
			})
		);
	}

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

		app.use(errorHandler({
			template: template
		}));
	}

	function initRoutes(app, passport, database, options) {
		options = options || {};
		var isPreview = options.preview;
		var themesUrl = options.themesUrl;

		initDefaultSiteRedirectRoutes(app);
		initAuthRoutes(app, passport, isPreview);
		initSiteRoutes(app, themesUrl, isPreview);
		app.use(invalidRoute());


		function initDefaultSiteRedirectRoutes(app) {
			app.get('/:user', createDefaultSiteRedirectRoute());
			app.get('/:user/login', createDefaultSiteRedirectRoute('/login'));
			app.post('/:user/login', createDefaultSiteRedirectRoute('/login'));
			app.get('/:user/logout', createDefaultSiteRedirectRoute('/logout'));
			app.get('/:user/download/*', createDefaultSiteRedirectRoute('/download/*'));
			app.get('/:user/thumbnail/*', createDefaultSiteRedirectRoute('/thumbnail/*'));


			function createDefaultSiteRedirectRoute(pathSuffix) {
				pathSuffix = pathSuffix || '';
				return function(req, res, next) {
					var username = req.params.user;
					userService.retrieveUserDefaultSiteName(username)
						.then(function(siteName) {
							if (!siteName) {
								throw new HttpError(404);
							}
							var wildcardPath = req.params[0];
							var WILDCARD_REGEXP = /\/\*$/;
							var fullPath = pathSuffix.replace(WILDCARD_REGEXP, '/' + wildcardPath);
							req.url = '/' + username + '/' + siteName + fullPath;
							next();
						})
						.catch(function(error) {
							next(error);
						});
				};
			}
		}

		function initAuthRoutes(app, passport, isPreview) {
			if (isPreview) {
				app.post('/:user/:site/login', processPreviewLoginRoute);
				app.get('/:user/:site/logout', processPreviewLogoutRoute);
			} else {
				app.get('/:user/:site/login', redirectIfLoggedIn);
				app.post('/:user/:site/login', processLoginRoute);
				app.get('/:user/:site/logout', processLogoutRoute);
			}


			function redirectIfLoggedIn(req, res, next) {
				var username = req.params.user;
				var siteName = req.params.site;
				if (req.isAuthenticated()) {
					var isLoggedIntoDifferentSite = (req.params.user !== req.user.user) || (req.params.site !== req.user.site);
					if (!isLoggedIntoDifferentSite) {
						return redirectToSitePage(req, res);
					}
				}
				siteService.retrieveSiteAuthenticationDetails(username, siteName, {
					published: true
				})
					.then(function(authenticationDetails) {
						var isPrivate = authenticationDetails.private;
						if (!isPrivate) { return redirectToSitePage(req, res); }
						next();
					})
					.catch(function(error) {
						next(error);
					});


				function redirectToSitePage(req, res) {
					var requestPath = req.originalUrl.split('?')[0];
					var redirectParam = req.params.redirect;
					var redirectUrl = (redirectParam || requestPath.substr(0, requestPath.lastIndexOf('/login')) || '/');
					return res.redirect(redirectUrl);
				}
			}

			function processLoginRoute(req, res, next) {
				passport.authenticate('site/local', function(error, user, info) {
					if (error) { return next(error); }
					var loginWasSuccessful = Boolean(user);
					var requestPath = req.originalUrl.split('?')[0];
					if (loginWasSuccessful) {
						ensurePreviousUserLoggedOut(req)
							.then(function() {
								req.login(user, function(error) {
									if (error) { return next(error); }
									var redirectParam = req.params.redirect;
									var redirectUrl = redirectParam || requestPath.replace(/\/login$/, '') || '/';
									res.redirect(redirectUrl);
								});
							})
							.catch(function(error) {
								next(error);
							});
					} else {
						var siteLoginUrl = requestPath;
						res.redirect(siteLoginUrl);
					}
				})(req, res, next);
			}

			function processLogoutRoute(req, res, next) {
				req.logout();
				req.session.destroy();
				var requestPath = req.originalUrl.split('?')[0];
				var redirectUrl = requestPath.substr(0, requestPath.lastIndexOf('/logout')) || '/';
				res.redirect(redirectUrl);
			}

			function processPreviewLoginRoute(req, res, next) {
				var requestPath = req.originalUrl.split('?')[0];
				var redirectUrl = requestPath.substr(0, requestPath.lastIndexOf('/login')) || '/';
				res.redirect(redirectUrl);
			}

			function processPreviewLogoutRoute(req, res, next) {
				var requestPath = req.originalUrl.split('?')[0];
				var redirectUrl = (requestPath.substr(0, requestPath.lastIndexOf('/logout')) || '') + '/login';
				res.redirect(redirectUrl);
			}
		}

		function initSiteRoutes(app, themesUrl, isPreview) {
			app.get('/:user/:site/login', loginRoute);
			app.get('/:user/:site', ensureAuth, siteRoute);
			app.get('/:user/:site/download/*', ensureAuth, downloadRoute);
			app.get('/:user/:site/thumbnail/*', ensureAuth, thumbnailRoute);


			function ensureAuth(req, res, next) {
				if (isPreview) { return next(); }
				var username = req.params.user;
				var siteName = req.params.site;
				if (req.isAuthenticated()) {
					var isLoggedIntoDifferentSite = (req.params.user !== req.user.user) || (req.params.site !== req.user.site);
					if (!isLoggedIntoDifferentSite) {
						return next();
					}
				}
				siteService.retrieveSiteAuthenticationDetails(username, siteName, {
					published: true
				})
					.then(function(authenticationDetails) {
						var isPrivate = authenticationDetails.private;
						if (!isPrivate) {
							return ensurePreviousUserLoggedOut(req)
								.then(function() {
									return next();
								})
								.catch(function(error) {
									return next(error);
								});
						}

						var requestPath = req.originalUrl.split('?')[0];

						var siteLoginUrl = '/login';
						var isDownloadLink = (requestPath.indexOf('/download') === 0);
						if (isDownloadLink) {
							// TODO: Generate login redirect link for download URLs (redirect to index page, then download file)
							siteLoginUrl += '?redirect=' + encodeURIComponent(requestPath);
						} else {
							siteLoginUrl = (requestPath === '/' ? '' : requestPath) + siteLoginUrl;
						}
						res.redirect(siteLoginUrl);
					})
					.catch(function(error) {
						next(error);
					});
			}

			function getSiteRootUrl(req, currentPath) {
				var requestPath = req.originalUrl.split('?')[0];
				if (currentPath) {
					requestPath = requestPath.replace(new RegExp(currentPath + '$'), '');
				}
				var siteRoot = (requestPath === '/' ? requestPath : requestPath + '/');
				return siteRoot;
			}

			function loginRoute(req, res, next) {
				var username = req.params.user;
				var siteName = req.params.site;
				userService.retrieveUser(username)
					.then(function(userModel) {
						var username = userModel.username;
						var published = !isPreview;
						var includeTheme = true;
						var includeContents = false;
						var includeUsers = false;
						var useCached = false;

						return siteService.retrieveSite(username, siteName, {
							published: published,
							theme: includeTheme,
							contents: includeContents,
							users: includeUsers,
							cacheDuration: (useCached ? Infinity : null)
						})
							.then(function(siteModel) {
								var context = {
									siteRoot: getSiteRootUrl(req, '/login'),
									themeRoot: themesUrl + siteModel.theme.id + '/',
									theme: siteModel.theme.config,
									site: {
										private: siteModel.private
									}
								};
								var templateName = siteModel.theme.id + '/login';
								res.render(templateName, context);
							});
					})
					.catch(function(error) {
						next(error);
					});
			}

			function siteRoute(req, res, next) {
				var username = req.params.user;
				var siteName = req.params.site;
				var useCached = (req.query.cached === 'true');
				var themeConfigOverrides = (req.query.config ? JSON.parse(req.query.config) : null);
				var adminUser = (isPreview ? req.user : null);
				userService.retrieveUser(username)
					.then(function(userModel) {
						var username = userModel.username;
						var published = !isPreview;
						var includeTheme = true;
						var includeContents = true;
						var includeUsers = false;
						return siteService.retrieveSite(username, siteName, {
							published: published,
							theme: includeTheme,
							contents: includeContents,
							users: includeUsers,
							cacheDuration: (useCached ? Infinity : null)
						})
							.then(function(siteModel) {
								var themeConfig = merge({}, siteModel.theme.config, themeConfigOverrides);
								var siteContents = siteModel.contents || { folders: null, files: null };
								var context = {
									siteRoot: getSiteRootUrl(req),
									themeRoot: themesUrl + siteModel.theme.id + '/',
									theme: themeConfig,
									admin: adminUser,
									site: {
										private: siteModel.private
									},
									contents: siteContents
								};
								var templateName = siteModel.theme.id + '/index';
								res.render(templateName, context);
							});
					})
					.catch(function(error) {
						next(error);
					});
			}

			function downloadRoute(req, res, next) {
				var username = req.params.user;
				var siteName = req.params.site;
				var filePath = req.params[0];

				siteService.retrieveSiteDownloadLink(username, siteName, filePath)
					.then(function(downloadUrl) {
						res.redirect(downloadUrl);
					})
					.catch(function(error) {
						next(error);
					});
			}

			function thumbnailRoute(req, res, next) {
				var username = req.params.user;
				var siteName = req.params.site;
				var filePath = req.params[0];

				siteService.retrieveSiteThumbnailLink(username, siteName, filePath)
					.then(function(thumbnailUrl) {
						res.redirect(thumbnailUrl);
					})
					.catch(function(error) {
						next(error);
					});
			}
		}

		function ensurePreviousUserLoggedOut(req) {
			var isPreviousUserLoggedIn = req.isAuthenticated();
			if (!isPreviousUserLoggedIn) { return Promise.resolve(); }
			return new Promise(function(resolve, reject) {
				req.logout();
				var passportSession = req.session.passport;
				req.session.regenerate(function(error) {
					if (error) { return reject(error); }
					req.session.passport = passportSession;
					resolve();
				});
			});
		}
	}
};
