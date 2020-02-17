/* global BASE_URL */
/* eslint-disable camelcase, no-underscore-dangle */

import $ from 'jquery';
import ko from 'knockout';
import logger from 'loglevel';
import config from 'picker-config';
import localization from './localization';
import util from './util';
// check babel.config.js for actual import path


function get_query_variable(name) {
  // eslint-disable-next-line no-param-reassign, no-useless-escape
  name = name.replace(/[\[]/, '\\[').replace(/[\]]/, '\\]');
  const regex = new RegExp(`[\\?&]${name}=([^&#]*)`);
  const results = regex.exec(window.location.search);
  return results === null ? ''
    : decodeURIComponent(results[1].replace(/\+/g, ' '));
}


// the following options are undocumented (internal use only)
// - exp_id
// - origin
// - api_version
// - flavor
// - upload_location_uri (used by the Dev Portal)
// - base_url
Object.assign(config, {
  /* options that can't be updated after initialization */
  // account_key is kept for b/w compatibility
  account_key: JSON.parse(get_query_variable('account_key')),
  api_version: get_query_variable('api_version'),
  app_id: get_query_variable('app_id'),
  create_folder: JSON.parse(get_query_variable('create_folder')),
  exp_id: get_query_variable('exp_id'),
  origin: get_query_variable('origin'),
  persist: JSON.parse(get_query_variable('persist')),
  services: JSON.parse(get_query_variable('services')),
  // Make sure all types are lowercase since we do a case-insensitive
  // search by lowercasing the search key and using types#indexOf.
  types: JSON.parse(get_query_variable('types')).map(str => str.toLowerCase()),

  /* options that can be updated by config.update() */
  account_management: ko.observable(true),
  all_services: ko.observableArray().extend({
    // We want the initial load to trigger one run of initialization
    // logic only.
    rateLimit: 500,
  }),
  base_url: String(BASE_URL).replace(/\/$/, ''),
  chunk_size: 5 * 1024 * 1024,
  computer: ko.observable(get_query_variable('flavor') === 'dropzone'),
  copy_to_upload_location: ko.observable(),
  dateTimeFormat: ko.observable('MMMdHm'),
  enable_logout: ko.observable(true),
  flavor: ko.observable(get_query_variable('flavor')),
  link: ko.observable(false),
  link_options: ko.observable({}),
  locale: ko.observable('en'),
  multiselect: ko.observable(false),
  retrieve_token: ko.observable(false),
  translations: ko.observable(''),
  upload_location_account: ko.observable(),
  upload_location_folder: ko.observable(),
  upload_location_uri: ko.observable(''),
  uploads_pause_on_error: ko.observable(true),
  user_data: ko.observable(), // Get asynchronously.
  delete_accounts_on_logout: ko.observable(false),
  custom_style_vars: ko.observable({}),
  root_folder_id: ko.observable({}),
});

/**
 * @param {ko.Observable<*>} observableObj - The observable object you want to
 *  monitor.
 * @param {Function} cb - The callback function that will be called when the
 *  observable object's value changes.
 */
function subscribeChange(observableObj, cb) {
  let oldValue = observableObj();
  observableObj.subscribe((value) => {
    oldValue = value;
  }, null, 'beforeChange');
  observableObj.subscribe((newValue) => {
    if (typeof newValue !== typeof oldValue) {
      cb(newValue, oldValue);
    } else if (typeof newValue === 'object') {
      if (JSON.stringify(newValue) !== JSON.stringify(oldValue)) {
        cb(newValue, oldValue);
      }
    } else if (newValue !== oldValue) {
      cb(newValue, oldValue);
    }
  });
}

let customStyleTask = null;
subscribeChange(config.custom_style_vars, (newCustomStyleVars) => {
  if (customStyleTask === null) {
    // only need to load less.js once
    customStyleTask = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.onload = resolve;
      script.onreadystatechange = resolve; // for IE
      script.onerror = reject;
      script.setAttribute('type', 'text/javascript');
      script.setAttribute('src', `${util.getBaseUrl()}/less.js`);
      document.head.append(script);
    }).catch(() => {
      logger.error('Failed to load less.js');
    });
  }

  customStyleTask = customStyleTask.then(() => {
    if (!window.less) {
      return Promise.reject(new Error('window.less is not defined.'));
    }
    // create style tag
    const id = `custom-style-vars-${Math.floor(Math.random() * (10 ** 12))}`;
    const styleElement = document.createElement('style');
    styleElement.setAttribute('id', id);
    styleElement.setAttribute('type', 'text/less');
    styleElement.textContent =
      `@import '${util.getBaseUrl()}/less/index.less';`;
    document.head.append(styleElement);
    return window.less.modifyVars(newCustomStyleVars);
  }).catch((err) => {
    logger.error(`Failed to update custom_style_vars: ${
      JSON.stringify(newCustomStyleVars)}.`);
    logger.error(err);
  });
});

config.localeOptions = ko.computed(() => JSON.stringify({
  locale: config.locale(),
  translations: config.translations(),
  dateTimeFormat: config.dateTimeFormat(),
})).extend({ rateLimit: 100 });

if (config.debug) {
  window.config = config;
}

if (!config.api_version) {
  config.api_version = 'v1';
  if (config.account_key) {
    // Also forced to v0 in app.js if keys are provided.
    config.api_version = 'v0';
  }
}

config.update = function update(data) {
  const configKeys = Object.keys(config);

  $.each(data, (k, v) => {
    if (configKeys.indexOf(k) === -1) {
      return;
    }

    // Ignore setting non-observables as that behavior is not expected
    // and the rest of the app cannot respond to it.
    if (typeof config[k] === 'function' && config[k].notifySubscribers) {
      // This is a ko.observable
      config[k](v);
    }
  });
};

/*
 * Get user_data
 */
function retrieveConfig() {
  const query_params = { app_id: config.app_id };
  if (config.account_key || config.retrieve_token()) {
    // Only do origin check if we need to.
    query_params.origin = config.origin;
  }
  if (config.upload_location_uri()) {
    query_params.upload_location_uri = config.upload_location_uri();
  }
  $.get(
    `${config.base_url}/file-picker/config/`,
    query_params,
    (config_data) => {
      config.user_data((config_data && config_data.user_data) || {});
    },
  );
}
config.retrieve_token.subscribe(retrieveConfig);
retrieveConfig();

/*
 * Get service data
 */
config._retrievedServices = false;

/*
 * compare function for sorting service order
 */
function getServiceOrderCompare() {
  // this anonymous function will execute instantly and return compare function
  const servicesOrder = {};
  if (config.services) {
    // exchange the key and value of config.services
    for (let i = 0; i < config.services.length; i += 1) {
      if (servicesOrder[config.services[i]] === undefined) {
        servicesOrder[config.services[i]] = i;
        if (config.services === 'all') {
          // break because 'all' cover whole services
          break;
        }
      }
    }
    // servicesOrder is like
    // {ftp: 0, gdrive: 1, object_store:2, all: 3}
  }

  /**
   * Get the minimum index
   * If the service doesn't exist in config.services,
   * this function will return Number.MAX_SAFE_INTEGER
   *
   * @param {Object} service
   * @returns {number}
   */
  function getServiceOrderIndex(service) {
    const allIndex = servicesOrder.all;
    const categoryIndex = servicesOrder[service.category];
    const idIndex = servicesOrder[service.id];

    let minIndex = Number.MAX_SAFE_INTEGER;

    if (allIndex !== undefined) {
      minIndex = allIndex;
    }
    if (categoryIndex !== undefined) {
      minIndex = Math.min(minIndex, categoryIndex);
    }
    if (idIndex !== undefined) {
      minIndex = Math.min(minIndex, idIndex);
    }

    return minIndex;
  }

  /**
   * compare function for sorting service order
   *
   * @param {Object} left - element of config.all_services
   * @param {Object} right - element of config.all_services
   *
   * config.all_services[0] = {
   *    id: ,
   *    name: ,
   *    logo:
   * }
   */
  return (left, right) => {
    const leftIndex = getServiceOrderIndex(left);
    const rightIndex = getServiceOrderIndex(right);
    if (leftIndex === rightIndex) {
      // if the indices are equal, use alphabetical order
      if (left.name === right.name) {
        return 0;
      }
      if (left.name < right.name) {
        return -1;
      }
      return 1;
    }
    return leftIndex < rightIndex ? -1 : 1;
  };
}
const serviceOrderCompare = getServiceOrderCompare();

$.get(
  `${config.base_url}/${config.api_version}/public/services`,
  {
    apis: 'storage',
    app_id: config.app_id,
  },
  (serviceData) => {
    config._retrievedServices = true;

    if (!config.services) {
      config.services = ['file_store'];
    } else if (config.services.indexOf('all') > -1) {
      config.services = ['file_store', 'object_store', 'construction'];
    }

    ko.utils.arrayForEach(serviceData.objects, (serviceDatum) => {
      // eslint-disable-next-line no-use-before-define
      const serviceCategory = getServiceCategory(serviceDatum);
      let localeName = localization.formatAndWrapMessage(
        `serviceNames/${serviceDatum.name}`,
      );
      if (localeName.indexOf('/') > -1) {
        localeName = serviceDatum.friendly_name;
      }

      const service = {
        id: serviceDatum.name,
        name: localeName,
        logo: serviceDatum.logo_url || (
          `${config.static_path}/webapp/sources/${serviceDatum.name}.png`
        ),
        category: serviceCategory,
        visible: false,
      };

      if (config.services.indexOf(serviceDatum.name) > -1
        || config.services.indexOf(serviceCategory) > -1) {
        service.visible = true;
      }
      config.all_services.push(service);
    });

    config.all_services.sort(serviceOrderCompare);

    // eslint-disable-next-line no-use-before-define
    config.visible_computer.subscribe(toggleComputer);
    // eslint-disable-next-line no-use-before-define
    toggleComputer(config.visible_computer());

    function getServiceCategory(service) {
      const objStoreServices = ['s3', 'azure', 's3_compatible'];

      if (objStoreServices.includes(service.name)) {
        return 'object_store';
      }
      if (service.category === 'construction') {
        return 'construction';
      }
      return 'file_store';
    }
  },
);

// Handle the Computer service being enabled/disabled.
config.visible_computer = ko.pureComputed(() => (
  config.computer() && config.flavor() !== 'saver'
  // Types other than 'folders' are present.
  && (
    config.types.length === 0
    || config.types.filter(f => f !== 'folders').length > 0
  )));


function toggleComputer(computerEnabled) {
  // Called after services are retrieved.
  if (computerEnabled && !(config.all_services()[0] || {}).computer) {
    config.all_services.unshift({
      computer: true,
      id: 'computer',
      name: localization.formatAndWrapMessage('serviceNames/computer'),
      visible: true,
      logo: `${config.static_path}/webapp/sources/computer.png`,
    });
  } else if (!computerEnabled
    && (config.all_services()[0] || {}).computer) {
    config.all_services.shift();
  }
}

/*
 * Create API server URLs
 */
config.getAccountUrl = function getAccountUrl(accountId, api, path) {
  let url = `${config.base_url}/${config.api_version}/accounts/`;
  if (!accountId) {
    return url;
  }

  url += `${accountId}/`;

  if (config.api_version === 'v0') {
    api = ''; // eslint-disable-line no-param-reassign
  } else if (!api) {
    api = 'storage'; // eslint-disable-line no-param-reassign
  }

  if (path) {
    url += (api ? `${api}/` : '') + path.replace(/^\/+/g, '');
  }
  return url;
};


// Type aliases
const aliases = {
  all: [
    'all',
  ],
  text: [
    'applescript',
    'as',
    'as3',
    'c',
    'cc',
    'clisp',
    'coffee',
    'cpp',
    'cs',
    'css',
    'csv',
    'cxx',
    'def',
    'diff',
    'erl',
    'fountain',
    'ft',
    'h',
    'hpp',
    'htm',
    'html',
    'hxx',
    'inc',
    'ini',
    'java',
    'js',
    'json',
    'less',
    'log',
    'lua',
    'm',
    'markdown',
    'mat',
    'md',
    'mdown',
    'mkdn',
    'mm',
    'mustache',
    'mxml',
    'patch',
    'php',
    'phtml',
    'pl',
    'plist',
    'properties',
    'py',
    'rb',
    'sass',
    'scss',
    'sh',
    'shtml',
    'sql',
    'tab',
    'taskpaper',
    'tex',
    'text',
    'tmpl',
    'tsv',
    'txt',
    'url',
    'vb',
    'xhtml',
    'xml',
    'yaml',
    'yml',
    ''],
  documents: [
    'csv',
    'doc',
    'dochtml',
    'docm',
    'docx',
    'docxml',
    'dot',
    'dothtml',
    'dotm',
    'dotx',
    'eps',
    'fdf',
    'key',
    'keynote',
    'kth',
    'mpd',
    'mpp',
    'mpt',
    'mpx',
    'nmbtemplate',
    'numbers',
    'odc',
    'odg',
    'odp',
    'ods',
    'odt',
    'pages',
    'pdf',
    'pdfxml',
    'pot',
    'pothtml',
    'potm',
    'potx',
    'ppa',
    'ppam',
    'pps',
    'ppsm',
    'ppsx',
    'ppt',
    'ppthtml',
    'pptm',
    'pptx',
    'pptxml',
    'prn',
    'ps',
    'pwz',
    'rtf',
    'tab',
    'template',
    'tsv',
    'txt',
    'vdx',
    'vsd',
    'vss',
    'vst',
    'vsx',
    'vtx',
    'wbk',
    'wiz',
    'wpd',
    'wps',
    'xdf',
    'xdp',
    'xlam',
    'xll',
    'xlr',
    'xls',
    'xlsb',
    'xlsm',
    'xlsx',
    'xltm',
    'xltx',
    'xps'],
  images: [
    'bmp',
    'cr2',
    'gif',
    'ico',
    'ithmb',
    'jpeg',
    'jpg',
    'nef',
    'png',
    'raw',
    'svg',
    'tif',
    'tiff',
    'wbmp',
    'webp'],
  videos: [
    '3g2',
    '3gp',
    '3gpp',
    '3gpp2',
    'asf',
    'avi',
    'dv',
    'dvi',
    'flv',
    'm2t',
    'm4v',
    'mkv',
    'mov',
    'mp4',
    'mpeg',
    'mpg',
    'mts',
    'ogv',
    'ogx',
    'rm',
    'rmvb',
    'ts',
    'vob',
    'webm',
    'wmv'],
  audio: [
    'aac',
    'aif',
    'aifc',
    'aiff',
    'au',
    'flac',
    'm4a',
    'm4b',
    'm4p',
    'm4r',
    'mid',
    'mp3',
    'oga',
    'ogg',
    'opus',
    'ra',
    'ram',
    'spx',
    'wav',
    'wma'],
  ebooks: [
    'acsm',
    'aeh',
    'azw',
    'cb7',
    'cba',
    'cbr',
    'cbt',
    'cbz',
    'ceb',
    'chm',
    'epub',
    'fb2',
    'ibooks',
    'kf8',
    'lit',
    'lrf',
    'lrx',
    'mobi',
    'opf',
    'oxps',
    'pdf',
    'pdg',
    'prc',
    'tebr',
    'tr2',
    'tr3',
    'xeb',
    'xps'],
};
let additions = [];

config.types = config.types.filter((type) => {
  if (type in aliases) {
    additions = additions.concat(aliases[type]);
    return false;
  }
  return true;
}).concat(additions);

// remove any duplicates
config.types = config.types.filter(
  (elem, pos) => config.types.indexOf(elem) === pos,
);

// default to 'all'
if (config.types.length === 0) {
  config.types.push('all');
}

// update the locale when the config changes
config.localeOptions.subscribe((options) => {
  const { locale, translations, dateTimeFormat } = JSON.parse(options);
  localization.setCurrentLocale(locale, translations, dateTimeFormat);
});

// load the default locale
localization.loadDefaultLocaleData();

export default config;
