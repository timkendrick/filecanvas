'use strict';

var path = require('path');
var Promise = require('promise');
var objectAssign = require('object-assign');
var express = require('express');
var passport = require('passport');
var DropboxOAuth2Strategy = require('passport-dropbox-oauth2').Strategy;
var slug = require('slug');

var handlebarsEngine = require('../engines/handlebars');
var HttpError = require('../errors/HttpError');

var UserService = require('../services/UserService');
var SiteService = require('../services/SiteService');
var UrlService = require('../services/UrlService');

var config = require('../../config');
var globals = require('../globals');

var faqData = require('../../templates/admin/faq.json');

module.exports = function(dataService) {
	var app = express();

	var DEFAULT_SITE_TEMPLATE = config.templates['default'];

	var assetsRoot = path.resolve(path.dirname(require.main.filename), 'templates/admin/assets');
	var assetsMiddleware = express.static(assetsRoot);
	app.use('/assets', assetsMiddleware);

	initAuth(
		dataService,
		config.dropbox.appKey,
		config.dropbox.appSecret,
		config.dropbox.loginCallbackUrl,
		config.dropbox.registerCallbackUrl
	);
	app.get('/login', redirectIfLoggedIn, initAdminSession, retrieveLoginRoute);
	app.get('/login/oauth2', passport.authenticate('admin/dropbox'));
	app.get('/login/oauth2/callback', passport.authenticate('admin/dropbox', { successRedirect: '/', failureRedirect: '/login' }));
	app.get('/register/oauth2', passport.authenticate('admin/register'));
	app.get('/register/oauth2/callback', passport.authenticate('admin/register', { successRedirect: '/', failureRedirect: '/login' }));
	app.get('/logout', initAdminSession, retrieveLogoutRoute);


	app.get('/', ensureAuth, initAdminSession, retrieveHomeRoute);

	app.get('/faq', ensureAuth, initAdminSession, retrieveFaqRoute);
	app.get('/support', ensureAuth, initAdminSession, retrieveSupportRoute);

	app.get('/account', ensureAuth, initAdminSession, retrieveUserAccountRoute);
	app.get('/account/domains', ensureAuth, initAdminSession, retrieveUserDomainsRoute);

	app.put('/account', ensureAuth, initAdminSession, updateUserAccountRoute);
	app.post('/account/domains', ensureAuth, initAdminSession, createUserDomainRoute);
	app.delete('/account/domains/:domain', ensureAuth, initAdminSession, deleteUserDomainRoute);

	app.get('/sites', ensureAuth, initAdminSession, retrieveSitesRoute);
	app.get('/sites/add', ensureAuth, initAdminSession, retrieveSiteAddRoute);
	app.get('/sites/edit/:site', ensureAuth, initAdminSession, retrieveSiteEditRoute);
	app.get('/sites/edit/:site/users', ensureAuth, initAdminSession, retrieveSiteUsersEditRoute);
	app.get('/sites/edit/:site/domains', ensureAuth, initAdminSession, retrieveSiteDomainsEditRoute);

	app.post('/sites', ensureAuth, initAdminSession, createSiteRoute);
	app.put('/sites/:site', ensureAuth, initAdminSession, updateSiteRoute);
	app.delete('/sites/:site', ensureAuth, initAdminSession, deleteSiteRoute);
	app.post('/sites/:site/users', ensureAuth, initAdminSession, createSiteUserRoute);
	app.delete('/sites/:site/users/:username', ensureAuth, initAdminSession, deleteSiteUserRoute);
	app.post('/sites/:site/domains', ensureAuth, initAdminSession, createSiteDomainRoute);
	app.delete('/sites/:site/domains/:domain', ensureAuth, initAdminSession, deleteSiteDomainRoute);

	app.engine('hbs', handlebarsEngine);
	app.set('views', './templates/admin');
	app.set('view engine', 'hbs');

	return app;


	function initAuth(dataService, appKey, appSecret, loginCallbackUrl, registerCallbackUrl) {
		globals.passport.serializers['admin'] = serializeAdminAuthUser;
		globals.passport.deserializers['admin'] = deserializeAdminAuthUser;

		passport.use('admin/dropbox', new DropboxOAuth2Strategy(
			{
				clientID: appKey,
				clientSecret: appSecret,
				callbackURL: loginCallbackUrl
			},
			function(accessToken, refreshToken, profile, callback) {
				var uid = profile.id;
				var profileName = profile.displayName;
				var profileEmail = profile.emails[0].value;
				return loginUser(dataService, uid, accessToken, profileName, profileEmail)
					.then(function(passportUser) {
						callback(null, passportUser);
					})
					.catch(function(error) {
						callback(error);
					});
			}
		));

		passport.use('admin/register', new DropboxOAuth2Strategy(
			{
				clientID: appKey,
				clientSecret: appSecret,
				callbackURL: registerCallbackUrl
			},
			function(accessToken, refreshToken, profile, callback) {
				var uid = profile.id;
				var profileName = profile.displayName;
				var profileEmail = profile.emails[0].value;
				return registerUser(dataService, uid, accessToken, profileName, profileEmail)
					.then(function(passportUser) {
						callback(null, passportUser);
					})
					.catch(function(error) {
						callback(error);
					});
			}
		));


		function loginUser(dataService, uid, accessToken, profileName, profileEmail) {
			return loadUserModel(dataService, uid, accessToken, profileName, profileEmail)
				.catch(function(error) {
					if (error.status === 404) {
						throw new HttpError(403, profileEmail + ' is not a registered user');
					}
					throw error;
				})
				.then(function(userModel) {
					var hasUpdatedAccessToken = userModel.token !== accessToken;
					if (hasUpdatedAccessToken) {
						return updateUserToken(dataService, uid, accessToken)
							.then(function() {
								userModel.token = accessToken;
								return userModel;
							});
					}
					return userModel;
				})
				.then(function(userModel) {
					var passportUser = {
						type: 'admin',
						model: userModel
					};
					return passportUser;
				});


			function loadUserModel(dataService, uid, accessToken, name, email) {
				var userService = new UserService(dataService);
				return userService.retrieveUser(uid);
			}

			function updateUserToken(dataService, uid, accessToken) {
				var userService = new UserService(dataService);
				return userService.updateUser(uid, { token: accessToken });
			}
		}

		function registerUser(dataService, uid, accessToken, profileName, profileEmail) {
			return createUserModel(dataService, uid, accessToken, profileName, profileEmail)
				.then(function(userModel) {
					var passportUser = {
						type: 'admin',
						model: userModel
					};
					return passportUser;
				});


			function createUserModel(dataService, uid, accessToken, name, email) {
				var userService = new UserService(dataService);
				var alias = slug(name, { lower: true });
				return userService.generateUniqueAlias(alias)
					.then(function(alias) {
						var userModel = {
							uid: uid,
							token: accessToken,
							alias: alias,
							name: name,
							email: email,
							default: null
						};
						return userService.createUser(userModel);
					});
			}
		}

		function serializeAdminAuthUser(passportUser, callback) {
			var serializedUser = passportUser.model.uid;
			return callback && callback(null, serializedUser);
		}

		function deserializeAdminAuthUser(serializedUser, callback) {
			var uid = Number(serializedUser);
			var userService = new UserService(dataService);
			return userService.retrieveUser(uid)
				.then(function(administratorModel) {
					var passportUser = {
						type: 'admin',
						model: administratorModel
					};
					return callback(null, passportUser);
				})
				.catch(function(error) {
					return callback(error);
				});
		}
	}

	function ensureAuth(req, res, next) {
		if (!req.isAuthenticated()) {
			res.redirect('/login');
			return;
		}
		next();
	}

	function redirectIfLoggedIn(req, res, next) {
		if (!req.isAuthenticated()) {
			return next();
		}
		res.redirect('/');
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
			var userModel = req.user && req.user.model || null;
			return getUserSites(dataService, userModel)
				.then(function(siteModels) {
					var urlService = new UrlService(req);
					var adminUrls = getAdminUrls(urlService, userModel);
					return {
						urls: adminUrls,
						location: urlService.location,
						sites: siteModels
					};
				});

			function getUserSites(dataService, userModel) {
				if (!userModel) { return Promise.resolve(null); }
				var uid = userModel.uid;
				var userService = new UserService(dataService);
				return userService.retrieveUserSites(uid);
			}

			function getAdminUrls(urlService, userModel) {
				return {
					webroot: (userModel ? urlService.getSubdomainUrl(userModel.alias) : null),
					domain: urlService.getSubdomainUrl('$0'),
					admin: '/',
					faq: '/faq',
					support: '/support',
					account: '/account',
					login: '/login',
					loginAuth: '/login/oauth2',
					registerAuth: '/register/oauth2',
					logout: '/logout',
					sites: '/sites',
					sitesAdd: '/sites/add',
					sitesEdit: '/sites/edit'
				};
			}
		}
	}

	function retrieveLoginRoute(req, res, next) {
		var templateData = {
			title: 'Login',
			content: null
		};
		renderAdminPage(req, res, 'login', templateData)
			.catch(function(error) {
				next(error);
			});
	}

	function retrieveLogoutRoute(req, res, next) {
		req.logout();
		req.session.destroy();
		res.redirect('/');
	}

	function retrieveHomeRoute(req, res, next) {
		res.redirect('/sites');
	}

	function retrieveFaqRoute(req, res, next) {
		var templateData = {
			title: 'FAQ',
			content: {
				questions: faqData
			}
		};
		renderAdminPage(req, res, 'faq', templateData)
			.catch(function(error) {
				next(error);
			});
	}

	function retrieveSupportRoute(req, res, next) {
		var templateData = {
			title: 'Support',
			content: null
		};
		renderAdminPage(req, res, 'support', templateData)
			.catch(function(error) {
				next(error);
			});
	}

	function retrieveUserAccountRoute(req, res, next) {
		var userModel = req.user.model;
		var uid = userModel.uid;
		var userService = new UserService(dataService);
		userService.retrieveUserDomains(uid)
			.then(function(domainModels) {
				var domainNames = domainModels.map(function(domainModel) {
					return domainModel.name;
				});
				var templateData = {
					title: 'Your account',
					content: {
						user: userModel,
						domains: domainNames
					}
				};
				return renderAdminPage(req, res, 'account', templateData);
			})
			.catch(function(error) {
				next(error);
			});
	}

	function updateUserAccountRoute(req, res, next) {
		var userModel = req.user.model;
		var uid = userModel.uid;
		var updates = {
			'alias': req.body.alias,
			'name': req.body.name,
			'email': req.body.email,
			'default': req.body.default || null
		};
		var userService = new UserService(dataService);
		userService.updateUser(uid, updates)
			.then(function(userModel) {
				res.redirect(303, '/account');
			})
			.catch(function(error) {
				next(error);
			});
	}

	function retrieveUserDomainsRoute(req, res, next) {
		var userModel = req.user.model;
		var uid = userModel.uid;
		var userService = new UserService(dataService);
		userService.retrieveUserDomains(uid)
			.then(function(domainModels) {
				var domainNames = domainModels.map(function(domainModel) {
					return domainModel.name;
				});
				var templateData = {
					title: 'Your account',
					content: {
						domains: domainNames
					}
				};
				return renderAdminPage(req, res, 'account/domains', templateData);
			})
			.catch(function(error) {
				next(error);
			});
	}

	function retrieveSitesRoute(req, res, next) {
		var templateData = {
			title: 'Your sites',
			content: {
				sites: res.locals.sites
			}
		};
		renderAdminPage(req, res, 'sites', templateData)
			.catch(function(error) {
				next(error);
			});
	}

	function retrieveSiteAddRoute(req, res, next) {
		var templateData = {
			title: 'Add a site',
			content: null
		};
		renderAdminPage(req, res, 'sites/add', templateData)
			.catch(function(error) {
				next(error);
			});
	}

	function retrieveSiteEditRoute(req, res, next) {
		var userModel = req.user.model;
		var uid = userModel.uid;
		var siteAlias = req.params.site;

		var siteService = new SiteService(dataService);
		var includeContents = false;
		var includeUsers = true;
		var includeDomains = true;
		siteService.retrieveSite(uid, siteAlias, includeContents, includeUsers, includeDomains)
			.then(function(siteModel) {
				var templateData = {
					title: 'Edit site: ' + siteModel.name,
					content: {
						site: siteModel
					}
				};
				return renderAdminPage(req, res, 'sites/edit', templateData);
			})
			.catch(function(error) {
				next(error);
			});
	}

	function retrieveSiteUsersEditRoute(req, res, next) {
		var userModel = req.user.model;
		var uid = userModel.uid;
		var siteAlias = req.params.site;

		var siteService = new SiteService(dataService);
		var includeContents = false;
		var includeUsers = true;
		var includeDomains = true;
		siteService.retrieveSite(uid, siteAlias, includeContents, includeUsers, includeDomains)
			.then(function(siteModel) {
				var templateData = {
					title: 'Edit site users: ' + siteModel.name,
					content: {
						site: siteModel
					}
				};
				return renderAdminPage(req, res, 'sites/edit/users', templateData);
			})
			.catch(function(error) {
				next(error);
			});
	}

	function retrieveSiteDomainsEditRoute(req, res, next) {
		var userModel = req.user.model;
		var uid = userModel.uid;
		var siteAlias = req.params.site;

		var siteService = new SiteService(dataService);
		var includeContents = false;
		var includeUsers = false;
		var includeDomains = true;
		siteService.retrieveSite(uid, siteAlias, includeContents, includeUsers, includeDomains)
			.then(function(siteModel) {
				var templateData = {
					title: 'Edit site domains: ' + siteModel.name,
					content: {
						site: siteModel
					}
				};
				return renderAdminPage(req, res, 'sites/edit/domains', templateData);
			})
			.catch(function(error) {
				next(error);
			});
	}

	function createSiteRoute(req, res, next) {
		var userModel = req.user.model;
		var uid = userModel.uid;

		// TODO: Allow user to set site theme when creating site
		// TODO: Allow user to set site users when creating site

		var siteModel = {
			'user': uid,
			'alias': req.body.alias,
			'name': req.body.name,
			'title': req.body.title,
			'template': DEFAULT_SITE_TEMPLATE,
			'path': req.body.path || null,
			'public': (req.body['private'] !== 'true')
		};

		var siteService = new SiteService(dataService);
		siteService.createSite(siteModel)
			.then(function(siteModel) {
				res.redirect(303, '/sites/edit/' + siteModel.alias);
			})
			.catch(function(error) {
				next(error);
			});
	}

	function updateSiteRoute(req, res, next) {
		var userModel = req.user.model;
		var uid = userModel.uid;
		var siteAlias = req.params.site;

		var isPurgeRequest = (req.body._action === 'purge');
		if (isPurgeRequest) {
			purgeSite(uid, siteAlias)
				.then(function() {
					res.redirect(303, '/sites/edit/' + siteAlias);
				})
				.catch(function(error) {
					next(error);
				});
		} else {

			// TODO: Allow user to update site theme when updating site

			var updates = {
				'user': uid,
				'alias': req.body.alias,
				'name': req.body.name,
				'title': req.body.title,
				'template': DEFAULT_SITE_TEMPLATE,
				'path': req.body.path || null,
				'public': (req.body['private'] !== 'true')
			};
			updateSite(uid, siteAlias, updates)
				.then(function() {
					res.redirect(303, '/sites/edit/' + updates.alias);
				})
				.catch(function(error) {
					next(error);
				});
		}


		function purgeSite(uid, siteAlias) {
			var cache = null;
			var siteService = new SiteService(dataService);
			return siteService.updateSiteCache(uid, siteAlias, cache);
		}

		function updateSite(uid, siteAlias, updates) {
			var siteService = new SiteService(dataService);
			return siteService.updateSite(uid, siteAlias, updates);
		}
	}

	function deleteSiteRoute(req, res, next) {
		var userModel = req.user.model;
		var uid = userModel.uid;
		var siteAlias = req.params.site;

		var siteService = new SiteService(dataService);
		siteService.deleteSite(uid, siteAlias)
			.then(function(siteModel) {
				res.redirect(303, '/sites');
			})
			.catch(function(error) {
				next(error);
			});
	}

	function createSiteUserRoute(req, res, next) {
		var userModel = req.user.model;
		var uid = userModel.uid;
		var siteAlias = req.params.site;
		var username = req.body.username;
		var password = req.body.password;

		var siteService = new SiteService(dataService);
		siteService.createSiteUser(uid, siteAlias, username, password)
			.then(function(userModel) {
				res.redirect(303, '/sites/edit/' + siteAlias + '/users');
			})
			.catch(function(error) {
				next(error);
			});
	}

	function deleteSiteUserRoute(req, res, next) {
		var userModel = req.user.model;
		var uid = userModel.uid;
		var siteAlias = req.params.site;
		var username = req.params.username;

		var siteService = new SiteService(dataService);
		siteService.deleteSiteUser(uid, siteAlias, username)
			.then(function() {
				res.redirect(303, '/sites/edit/' + siteAlias + '/users');
			})
			.catch(function(error) {
				next(error);
			});
	}

	function createUserDomainRoute(req, res, next) {
		var userModel = req.user.model;
		var uid = userModel.uid;
		var domain = req.body.domain;

		var userService = new UserService(dataService);
		userService.createUserDomain(uid, domain)
			.then(function(domain) {
				res.redirect(303, '/account/domains');
			})
			.catch(function(error) {
				next(error);
			});
	}

	function deleteUserDomainRoute(req, res, next) {
		var userModel = req.user.model;
		var uid = userModel.uid;
		var domain = req.params.domain;

		var userService = new UserService(dataService);
		userService.deleteUserDomain(uid, domain)
			.then(function() {
				res.redirect(303, '/account/domains');
			})
			.catch(function(error) {
				next(error);
			});
	}

	function createSiteDomainRoute(req, res, next) {
		var userModel = req.user.model;
		var uid = userModel.uid;
		var siteAlias = req.params.site;
		var domain = req.body.domain;

		var siteService = new SiteService(dataService);
		siteService.createSiteDomain(uid, siteAlias, domain)
			.then(function(domain) {
				res.redirect(303, '/sites/edit/' + siteAlias + '/domains');
			})
			.catch(function(error) {
				next(error);
			});
	}

	function deleteSiteDomainRoute(req, res, next) {
		var userModel = req.user.model;
		var uid = userModel.uid;
		var siteAlias = req.params.site;
		var domain = req.params.domain;

		var siteService = new SiteService(dataService);
		siteService.deleteSiteDomain(uid, siteAlias, domain)
			.then(function() {
				res.redirect(303, '/sites/edit/' + siteAlias + '/domains');
			})
			.catch(function(error) {
				next(error);
			});
	}

	function renderAdminPage(req, res, templateName, context) {
		return new Promise(function(resolve, reject) {
			var templateData = getTemplateData(req, res, context);
			res.render(templateName, templateData, function(error, pageContent) {
				if (error) { return reject(error); }
				var templateOptions = {
					partials: {
						'page': pageContent
					}
				};
				var templateData = getTemplateData(req, res, context, templateOptions);
				res.render('index', templateData, function(error, data) {
					if (error) { return reject(error); }
					res.send(data);
					resolve(data);
				});
			});
		});


		function getTemplateData(req, res, context, templateOptions) {
			templateOptions = templateOptions || null;
			var templateData = {
				_: templateOptions,
				session: getTemplateSessionData(req, res)
			};
			return objectAssign({}, context, templateData);
		}

		function getTemplateSessionData(req, res) {
			var session = {
				user: req.user ? req.user.model : null
			};
			return objectAssign({}, res.locals, session);
		}
	}
};
