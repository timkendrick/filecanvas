'use strict';

var junk = require('junk');
var objectAssign = require('object-assign');
var vdom = require('virtual-dom');
var virtualize = require('vdom-virtualize');
var template = require('lodash.template');
var merge = require('lodash.merge');
var isEqual = require('lodash.isequal');
var Mousetrap = require('mousetrap');
var Handlebars = require('handlebars/runtime');

var HistoryStack = require('./lib/HistoryStack');

var handlebarsHelpers = require('../../src/engines/handlebars/helpers/index');

var LIVE_UPDATE_DEBOUNCE_DURATION = 500;

window.Handlebars = Handlebars;

$(function() {
	initColorpickers();
	initSidepanel();
	initLivePreview();
});


function initColorpickers() {
	var isChanging = false;
	$('[data-colorpicker]').colorpicker().on('changeColor.colorpicker', function(event) {
		if (isChanging) { return; }
		var $colorPickerElement = $(this);
		var $inputElement = $colorPickerElement.data('colorpicker').input;
		isChanging = true;
		$inputElement.change();
		isChanging = false;
	});
}

function initSidepanel() {
	$('[data-toggle="collapse-sidepanel"]').on('click', function(event) {
		var targetSelector = $(this).data('target');
		var $targetElement = $(targetSelector);
		$targetElement.toggleClass('collapsed');
	});
}

function initLivePreview() {
	var $formElement = $('[data-editor-form]');
	var $previewElement = $('[data-editor-preview]');
	var $undoButtonElement = $('[data-editor-undo]');
	var $redoButtonElement = $('[data-editor-redo]');
	var iframeSrc = $previewElement.data('src');

	var precompiledTemplate = Handlebars.templates['index'];
	var templateFunction = createTemplateFunction(precompiledTemplate, handlebarsHelpers);
	var currentSiteModel = null;
	var currentThemeConfigOverrides = null;
	var patchIframeContent = null;
	var previewUrl = getPreviewUrl(iframeSrc);

	showLoadingIndicator($previewElement);
	loadPreview(function(domPatcher) {
		patchIframeContent = domPatcher;
		hideLoadingIndicator($previewElement);
	});
	initInlineUploads();
	initLiveUpdates();


	function showLoadingIndicator($previewElement) {
		$previewElement.addClass('loading');
	}

	function hideLoadingIndicator($previewElement) {
		$previewElement.removeClass('loading');
	}

	function createTemplateFunction(precompiledTemplate, helpers) {
		var compiler = Handlebars.create();
		Object.keys(helpers).forEach(function(helperName) {
			var helper = helpers[helperName];
			compiler.registerHelper(helperName, helper);
		});
		var templateFunction = compiler.template(precompiledTemplate);
		return templateFunction;
	}

	function getPreviewUrl(previewUrl, params) {
		if (!params) { return previewUrl; }
		var baseUrl = previewUrl.split('#')[0].split('?')[0];
		return baseUrl + '?' + serializeQueryParams(params);


		function serializeQueryParams(params) {
			return Object.keys(params).map(function(key) {
				var value = params[key];
				return key + '=' + encodeURIComponent(JSON.stringify(value));
			}).join('&');
		}
	}

	function loadPreview(callback) {
		loadJson(previewUrl)
			.then(function(siteModel) {
				var html = templateFunction(siteModel);
				currentSiteModel = siteModel;
				var previewIframeElement = $previewElement[0];
				previewIframeElement.srcdoc = html;
				onIframeDomReady(previewIframeElement)
					.then(function(iframeDocumentElement) {
						var patcher = initVirtualDomPatcher(iframeDocumentElement);
						updatePreview(currentSiteModel, currentThemeConfigOverrides);
						callback(patcher);
					});
			});


		function initVirtualDomPatcher(documentElement) {
			var htmlElement = documentElement.documentElement;
			var currentTree = virtualize(htmlElement);
			return patch;


			function patch(updatedHtml) {
				var updatedTree = virtualize.fromHTML(updatedHtml);
				var diff = vdom.diff(currentTree, updatedTree);
				vdom.patch(htmlElement, diff);
				currentTree = updatedTree;
			}
		}
	}

	function updatePreview(siteModel, themeConfig) {
		var customizedSiteModel = getCustomizedSiteModel(siteModel, themeConfig);
		var html = templateFunction(customizedSiteModel);
		if (patchIframeContent) { patchIframeContent(html); }


		function getCustomizedSiteModel(siteModel, themeConfig) {
			if (!themeConfig) { return siteModel; }
			return merge({}, siteModel, {
				metadata: {
					theme: {
						config: themeConfig
					}
				}
			});
		}
	}

	function initLiveUpdates() {
		var initialFormValues = getFormFieldValues($formElement);
		var formUndoHistory = new HistoryStack();
		formUndoHistory.add(initialFormValues);
		$formElement.on('input', debounce(onFormFieldChanged, LIVE_UPDATE_DEBOUNCE_DURATION));
		$formElement.on('change', onFormFieldChanged);
		$undoButtonElement.on('click', onUndoButtonClicked);
		$redoButtonElement.on('click', onRedoButtonClicked);
		Mousetrap.bind('mod+z', onCtrlZPressed);
		Mousetrap.bind('mod+shift+z', onCtrlShiftZPressed);


		function getFormFieldValues($formElement) {
			var formFieldValues = parseFormFieldValues($formElement);
			var nestedFormFieldValues = parseNestedPropertyValues(formFieldValues);
			return nestedFormFieldValues;


			function parseFormFieldValues($formElement) {
				var fieldElements = Array.prototype.slice.call($formElement.prop('elements'));
				return fieldElements.map(function(element) {
					var elementName = element.name;
					var elementValue = element.value;
					return {
						'key': elementName,
						'value': elementValue
					};
				})
				.filter(function(property) {
					var key = property.key;
					return (key && (key.charAt(0) !== '_'));
				})
				.reduce(function(values, property) {
					var key = property.key;
					var value = property.value;
					values[key] = value;
					return values;
				}, {});
			}

			function parseNestedPropertyValues(values) {
				return Object.keys(values).map(function(key) {
					return {
						key: key,
						value: values[key]
					};
				}).reduce(function(values, property) {
					var propertyName = property.key;
					var propertyValue = property.value;
					var propertyNameSegments = propertyName.split('.');
					propertyNameSegments.reduce(function(parent, propertyNameSegment, index, array) {
						if (index === array.length - 1) {
							parent[propertyNameSegment] = propertyValue;
							return propertyValue;
						}
						if (!(propertyNameSegment in parent)) {
							parent[propertyNameSegment] = {};
						}
						return parent[propertyNameSegment];
					}, values);
					return values;
				}, {});
			}
		}

		function setFormFieldValues($formElement, fieldValues) {
			var flattenedFieldValues = getFlattenedPropertyValues(fieldValues);
			updateFormValues($formElement, flattenedFieldValues);


			function getFlattenedPropertyValues(nestedValues) {
				return flattenObjectKeys(nestedValues, '');

				function flattenObjectKeys(object, keyPrefix) {
					return Object.keys(object).reduce(function(flattenedValues, key) {
						var propertyValue = object[key];
						var isNestedObject = propertyValue && (typeof propertyValue === 'object');
						if (isNestedObject) {
							var childKeyPrefix = keyPrefix + key + '.';
							objectAssign(flattenedValues, flattenObjectKeys(propertyValue, childKeyPrefix));
						} else {
							flattenedValues[keyPrefix + key] = propertyValue;
						}
						return flattenedValues;
					}, {});
				}
			}

			function updateFormValues($formElement, fieldValues) {
				var fieldElements = Array.prototype.slice.call($formElement.prop('elements'));
				fieldElements.forEach(function(element) {
					var elementName = element.name;
					if (elementName in fieldValues) {
						var fieldValue = fieldValues[elementName];
						element.value = fieldValue;
					}
				});
			}
		}

		function onFormFieldChanged(event) {
			var $formElement = $(event.currentTarget);
			var formValues = getFormFieldValues($formElement);
			var hasChanged = !isEqual(formValues, formUndoHistory.getState());
			if (!hasChanged) { return; }
			formUndoHistory.add(formValues);
			updateUndoRedoButtonState();
			updateFormPreview(formValues);
		}

		function onUndoButtonClicked(event) {
			undo();
		}

		function onRedoButtonClicked(event) {
			redo();
		}

		function onCtrlZPressed(event) {
			event.stopImmediatePropagation();
			event.preventDefault();
			var isUndoDisabled = !formUndoHistory.getHasPrevious();
			if (isUndoDisabled) { return; }
			undo();
		}

		function onCtrlShiftZPressed(event) {
			event.preventDefault();
			event.stopImmediatePropagation();
			var isRedoDisabled = !formUndoHistory.getHasNext();
			if (isRedoDisabled) { return; }
			redo();
		}

		function undo() {
			formUndoHistory.previous();
			updateUndoRedoButtonState();
			var formValues = formUndoHistory.getState();
			setFormFieldValues($formElement, formValues);
			updateFormPreview(formValues);
		}

		function redo() {
			formUndoHistory.next();
			updateUndoRedoButtonState();
			var formValues = formUndoHistory.getState();
			setFormFieldValues($formElement, formValues);
			updateFormPreview(formValues);
		}

		function updateFormPreview(formValues) {
			currentThemeConfigOverrides = formValues.theme.config;
			setTimeout(function() {
				updatePreview(currentSiteModel, currentThemeConfigOverrides);
			});
		}

		function updateUndoRedoButtonState() {
			var isUndoDisabled = !formUndoHistory.getHasPrevious();
			var isRedoDisabled = !formUndoHistory.getHasNext();
			$undoButtonElement.prop('disabled', isUndoDisabled);
			$redoButtonElement.prop('disabled', isRedoDisabled);
		}

		function debounce(func, wait, immediate) {
			var timeout;
			return function() {
				var context = this, args = arguments;
				var later = function() {
					timeout = null;
					if (!immediate) { func.apply(context, args); }
				};
				var callNow = immediate && !timeout;
				clearTimeout(timeout);
				timeout = setTimeout(later, wait);
				if (callNow) { func.apply(context, args); }
			};
		}
	}

	function initInlineUploads() {
		var $previewElement = $('[data-editor-preview]');
		var $progressElement = $('[data-editor-progress]');
		var $progressLabelElement = $('[data-editor-progress-label]');
		var $progressBarElement = $('[data-editor-progress-bar]');
		var $progressCancelButtonElement = $('[data-editor-progress-cancel]');
		var $uploadStatusModalElement = $('[data-editor-upload-status-modal]');
		var shuntApi = window.shunt;
		var adapterConfig = loadAdapterConfig();
		var activeUpload = null;
		var showUploadStatus = initUploadStatusModal($uploadStatusModalElement);
		initUploadHotspots($previewElement, onFilesSelected);
		$progressCancelButtonElement.on('click', onUploadCancelRequested);


		function loadAdapterConfig() {
			var cookies = parseCookies(document.cookie);
			var adapterConfig = JSON.parse(cookies.adapter);
			return adapterConfig;

			function parseCookies(cookiesString) {
				var cookies = cookiesString.split(/;\s*/).map(function(cookieString) {
					var match = /^(.*?)=(.*)$/.exec(cookieString);
					return {
						key: match[1],
						value: match[2]
					};
				}).reduce(function(cookies, cookie) {
					cookies[cookie.key] = decodeURIComponent(cookie.value);
					return cookies;
				}, {});
				return cookies;
			}
		}

		function initUploadStatusModal($element) {
			var $modalElement = $element.modal({
				show: false
			});
			var $bodyElement = $modalElement.find('.modal-body');
			var bodyTemplate = $bodyElement.children().remove().text();
			var bodyTemplateFunction = template(bodyTemplate);
			return function showUploadStatus(context) {
				var html = bodyTemplateFunction(context);
				$bodyElement.html(html);
				$modalElement.modal('show');
			};
		}

		function initUploadHotspots($previewIframeElement, uploadCallback) {
			var previewIframeElement = $previewIframeElement[0];
			onIframeDomReady(previewIframeElement)
				.then(function(previewDocument) {
					var $previewDocument = $(previewDocument);
					disableContextMenu($previewDocument);
					addHotspotListeners($previewDocument, '[data-admin-upload]', uploadCallback);
				});


			function disableContextMenu($document) {
				$document.on('contextmenu', function(event) {
					event.preventDefault();
				});
			}

			function addHotspotListeners($element, selector, uploadCallback) {
				var $activeDropTarget = null;
				$element
					.on('dragenter dragover', '[data-admin-upload]', function(event) {
						var $element = $(this);
						var dataTransfer = event.originalEvent.dataTransfer;
						var shouldAcceptDrag = getIsFileDrag(dataTransfer);
						if (!shouldAcceptDrag) { return; }
						event.stopPropagation();
						acceptDropOperation(event.originalEvent, 'copy');
						setActiveDropTarget($element);


						function getIsFileDrag(dataTransfer) {
							var mimeTypes = Array.prototype.slice.call(dataTransfer.types);
							var isFileDrag = (mimeTypes.indexOf('Files') !== -1);
							return isFileDrag;
						}

						function acceptDropOperation(event, dropEffect) {
							event.dataTransfer.dropEffect = dropEffect;
							event.preventDefault();
						}
					})
					.on('dragleave', '[data-admin-upload]', function(event) {
						event.stopPropagation();
						setActiveDropTarget(null);
					})
					.on('drop', '[data-admin-upload]', function(event) {
						var $element = $(this);
						var dataTransfer = event.originalEvent.dataTransfer;
						event.preventDefault();
						event.stopPropagation();
						setActiveDropTarget(null);
						if (!dataTransfer) { return; }
						var pathPrefix = $element.data('admin-upload') || '';
						if (dataTransfer.items) {
							loadDataTransferItems(dataTransfer.items, onFilesLoaded);
						} else if (dataTransfer.files) {
							loadDataTransferFiles(dataTransfer.files, onFilesLoaded);
						}


						function onFilesLoaded(files) {
							var prefixedFiles = getPathPrefixedFiles(files, pathPrefix);
							uploadCallback(prefixedFiles);


							function getPathPrefixedFiles(files, pathPrefix) {
								if (!pathPrefix) { return files; }
								return files.map(function(file) {
									return {
										path: pathPrefix + file.path,
										data: file.data
									};
								});
							}
						}
					})
					.on('dragend', function(event) {
						setActiveDropTarget(null);
					});


				function setActiveDropTarget($element) {
					if ($activeDropTarget === $element) { return; }
					if ($activeDropTarget) { $activeDropTarget.removeClass('dragging'); }
					$activeDropTarget = $element;
					if ($activeDropTarget) { $activeDropTarget.addClass('dragging'); }
				}

				function loadDataTransferItems(itemsList, callback) {
					var items = Array.prototype.slice.call(itemsList);
					var entries = items.map(function(item) {
						if (item.getAsEntry) { return item.getAsEntry(); }
						if (item.webkitGetAsEntry) { return item.webkitGetAsEntry(); }
						return item;
					});
					loadEntries(entries, callback);


					function loadEntries(entries, callback) {
						if (entries.length === 0) { return callback([]); }
						var numRemaining = entries.length;
						var files = entries.map(function(entry, index) {
							loadEntry(entry, function(result) {
								files[index] = result;
								if (--numRemaining === 0) {
									var flattenedFiles = getFlattenedFiles(files);
									callback(flattenedFiles);
								}
							});
							return undefined;


							function getFlattenedFiles(files) {
								return files.reduce(function(flattenedFiles, file) {
									return flattenedFiles.concat(file);
								}, []);
							}
						});


						function loadEntry(entry, callback) {
							if (entry.isFile) {
								loadFile(entry, callback);
							} else if (entry.isDirectory) {
								loadDirectory(entry, callback);
							}


							function loadFile(entry, callback) {
								entry.file(function(file) {
									callback({
										path: entry.fullPath,
										data: file
									});
								});
							}

							function loadDirectory(entry, callback) {
								var reader = entry.createReader();
								reader.readEntries(function(entries) {
									loadEntries(entries, callback);
								});
							}
						}
					}
				}

				function loadDataTransferFiles(fileList, callback) {
					var files = Array.prototype.slice.call(fileList);
					setTimeout(function() {
						callback(files.map(function(file) {
							return {
								path: '/' + file.name,
								data: file
							};
						}));
					});
				}
			}
		}

		function onFilesSelected(files) {
			var filteredFiles = getFilteredFiles(files);
			var isUploadInProgress = Boolean(activeUpload);
			if (isUploadInProgress) {
				activeUpload.append(filteredFiles);
			} else {
				activeUpload = uploadFiles(filteredFiles, shuntApi, adapterConfig);
				activeUpload.always(function() {
					activeUpload = null;
				});
			}


			function getFilteredFiles(files) {
				return files.filter(function(file) {
					var filename = file.data.name;
					return junk.not(filename);
				});
			}

			function uploadFiles(files, shuntApi, adapterConfig) {
				showUploadProgressIndicator();
				var upload = shuntApi.uploadFiles(files, {
					adapter: adapterConfig,
					retries: 2
				});
				upload
					.progress(function(uploadBatch) {
						setUploadProgress(uploadBatch);
					})
					.then(function(uploadBatch) {
						var hasErrors = uploadBatch.numFailed > 0;
						if (hasErrors) {
							showUploadStatus({
								error: null,
								upload: uploadBatch
							});
						}
					})
					.fail(function(error) {
						showUploadStatus({
							error: error,
							upload: null
						});
					})
					.always(function() {
						loadJson(previewUrl)
							.then(function(siteModel) {
								currentSiteModel = siteModel;
								updatePreview(currentSiteModel, currentThemeConfigOverrides);
							})
							.always(function() {
								hideUploadProgressIndicator();
							});
					});
				return upload;


				function showUploadProgressIndicator() {
					setProgressBarLabel(null);
					setProgressBarValue({
						loaded: 0,
						total: 0
					});
					$progressBarElement.attr('aria-valuenow', 0);
					$progressElement.addClass('active');
				}

				function hideUploadProgressIndicator() {
					$progressElement.removeClass('active');
					setProgressBarValue({
						loaded: 0,
						total: 0
					});
				}

				function setProgressBarLabel(message) {
					$progressLabelElement.text(message || '');
				}

				function setProgressBarValue(options) {
					options = options || {};
					var loaded = options.loaded || 0;
					var total = options.total || 0;
					var percentLoaded = 100 * (total === 0 ? 0 : loaded / total);
					$progressBarElement.attr('aria-valuemin', 0);
					$progressBarElement.attr('aria-valuemax', total);
					$progressBarElement.attr('aria-valuenow', loaded);
					$progressBarElement.attr('data-percent', percentLoaded);
					$progressBarElement.css('width', percentLoaded + '%');
				}

				function setUploadProgress(uploadBatch) {
					var currentFilename = uploadBatch.currentItem && uploadBatch.currentItem.filename || null;
					setProgressBarLabel(currentFilename);
					setProgressBarValue({
						loaded: uploadBatch.bytesLoaded,
						total: uploadBatch.bytesTotal
					});
				}
			}
		}

		function onUploadCancelRequested(event) {
			if (activeUpload) { activeUpload.abort(); }
		}
	}

	function getIframeDomElement(iframeElement) {
		return (iframeElement.contentDocument || iframeElement.contentWindow.document);
	}

	function onIframeDomReady(iframeElement) {
		var deferred = new $.Deferred();
		var iframeDocumentElement = getIframeDomElement(iframeElement);
		var isEmptyDocument = getIsEmptyDocument(iframeDocumentElement);
		if (isEmptyDocument) {
			// HACK: See Webkit bug #33604 (https://bugs.webkit.org/show_bug.cgi?id=33604)
			// Sometimes the iframe does not yet contain the correct document,
			// so we need to poll until the current document is the correct one
			var pollInterval = 50;
			setTimeout(
				function() {
					onIframeDomReady(iframeElement)
						.then(function(documentElement) {
							deferred.resolve(documentElement);
						});
				},
				pollInterval
			);
		} else {
			iframeDocumentElement.addEventListener('DOMContentLoaded', function(event) {
				deferred.resolve(iframeDocumentElement);
			});
		}
		return deferred.promise();


		function getIsEmptyDocument(documentElement) {
			return (documentElement.location.href === 'about:blank') &&
			!documentElement.head.hasChildNodes() &&
			!documentElement.body.hasChildNodes();
		}
	}

	function loadJson(url) {
		return $.ajax({
			url: url,
			dataType: 'json',
			headers: {
				'Accept': 'application/json'
			}
		})
			.then(function(data, textStatus, jqXHR) {
				return new $.Deferred().resolve(data).promise();
			})
			.fail(function(jqXHR, textStatus, errorThrown) {
				return new $.Deferred().reject(new Error(errorThrown)).promise();
			});
	}
}
