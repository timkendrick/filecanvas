'use strict';

var merge = require('lodash.merge');
var memoize = require('lodash.memoize');

var constants = require('../../constants');

var helpers = require('./helpers');

var HandlebarsService = require('./HandlebarsService');

var COMPILER_OPTIONS = constants.HANDLEBARS_COMPILER_OPTIONS;
var DEFAULT_TEMPLATE_OPTIONS = constants.HANDLEBARS_DEFAULT_TEMPLATE_OPTIONS;
var SERIALIZED_TEMPLATES_NAMESPACE = constants.HANDLEBARS_SERIALIZED_TEMPLATES_NAMESPACE;
var SERIALIZED_PARTIALS_NAMESPACE = constants.HANDLEBARS_SERIALIZED_PARTIALS_NAMESPACE;

var templatesNamespace = SERIALIZED_TEMPLATES_NAMESPACE;
var partialsNamespace = SERIALIZED_PARTIALS_NAMESPACE;
var defaultTemplateOptions = DEFAULT_TEMPLATE_OPTIONS;

var templateService = new HandlebarsService({
	helpers: helpers,
	compiler: COMPILER_OPTIONS
});

function engine(templatePath, context, callback) {
	// Extract the Handlebars render options from the
	// magic `_` property within the context hash
	var templateOptions = context._ || {};

	// Render the Handlebars template
	return engine.render(templatePath, context, templateOptions)
		.then(function(output) {
			callback(null, output);
		})
		.catch(function(error) {
			callback(error);
		});
}

engine.render = function(templatePath, context, templateOptions) {
	return compileTemplateBundle(templatePath, templateOptions)
		.then(function(render) {
			return render(context);
		});
};

engine.serialize = function(templatePath, templateId, templateOptions) {
	return serializeTemplateBundle(templatePath, templateId, templateOptions);
};

var compile = memoize(function(templatePath) {
	return templateService.compile(templatePath);
});

var precompile = memoize(function(templatePath) {
	return templateService.serialize(templatePath);
});

var compileTemplate = memoize(function(templatePath) {
	return compile(templatePath);
});

var compilePartial = memoize(function(templatePath) {
	return compile(templatePath);
});

var serializeTemplate = memoize(function(templatePath, templateId) {
	return precompile(templatePath)
		.then(function(precompiledTemplate) {
			return wrapHandlebarsTemplate(precompiledTemplate, {
				namespace: templatesNamespace,
				id: templateId
			});
		});
});

var serializePartial = memoize(function(partialPath, partialId) {
	return precompile(partialPath)
		.then(function(precompiledPartial) {
			return wrapHandlebarsTemplate(precompiledPartial, {
				namespace: partialsNamespace,
				id: partialId
			});
		});
});

function compileTemplateBundle(templatePath, templateOptions) {
	templateOptions = merge({}, defaultTemplateOptions, templateOptions);
	var partials = templateOptions.partials;
	return Promise.all([
		compileTemplate(templatePath),
		compilePartials(partials)
	])
		.then(function(values) {
			var compiledTemplate = values[0];
			var compiledPartials = values[1];
			var renderOptions = merge({}, templateOptions, { partials: compiledPartials });
			return function(context) {
				var output = templateService.render(compiledTemplate, context, renderOptions);
				return Promise.resolve(output);
			};
		});


		function compilePartials(partials) {
			if (!partials) { return Promise.resolve({}); }
			var partialIds = Object.keys(partials);
			var partialPaths = partialIds.map(
				function(partialId) { return partials[partialId]; }
			);
			return Promise.all(
				partialPaths.map(function(partialPath) {
					return compilePartial(partialPath);
				})
			).then(function(compiledPartials) {
				return compiledPartials.reduce(function(compiledPartialsHash, compiledPartial, index) {
					var partialId = partialIds[index];
					compiledPartialsHash[partialId] = compiledPartial;
					return compiledPartialsHash;
				}, {});
			});
		}
}

function serializeTemplateBundle(templatePath, templateId, templateOptions) {
	templateOptions = merge({}, defaultTemplateOptions, templateOptions);
	var partials = templateOptions.partials;
	return Promise.all([
		serializeTemplate(templatePath, templateId),
		serializePartials(partials)
	])
		.then(function(values) {
			var serializedTemplate = values[0];
			var serializedPartials = values[1];
			var serializedPartialsArray = objectValues(serializedPartials);
			var serializedTemplates = serializedPartialsArray.concat(serializedTemplate);
			return serializedTemplates.join('\n');
		});


	function serializePartials(partials) {
		if (!partials) { return Promise.resolve({}); }
		var partialIds = Object.keys(partials);
		var partialPaths = partialIds.map(
			function(partialId) { return partials[partialId]; }
		);
		return Promise.all(
			partialPaths.map(function(partialPath, index) {
				var partialId = partialIds[index];
				return serializePartial(partialPath, partialId);
			})
		).then(function(compiledPartials) {
			return compiledPartials.reduce(function(compiledPartialsHash, compiledPartial, index) {
				var partialId = partialIds[index];
				compiledPartialsHash[partialId] = compiledPartial;
				return compiledPartialsHash;
			}, {});
		});
	}
}

function wrapHandlebarsTemplate(template, options) {
	options = options || {};
	var namespace = options.namespace;
	var templateId = options.id;
	return '(' + namespace + '=' + namespace + '||{})["' + templateId + '"]=' + template + ';';
}

function objectValues(object) {
	return Object.keys(object).map(function(key) {
		return object[key];
	});
}

module.exports = engine;