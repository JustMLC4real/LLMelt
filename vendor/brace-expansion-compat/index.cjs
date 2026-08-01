'use strict';

/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- Oude minimatch-versies laden deze compatibiliteitslaag bewust via CommonJS. */
const secureBraceExpansion = require('brace-expansion-secure');

function expandCompat(pattern, options) {
  return secureBraceExpansion.expand(pattern, options);
}

// Oudere minimatch-versies verwachten dat require('brace-expansion') direct
// aanroepbaar is; moderne versies importeren juist de benoemde `expand`.
module.exports = expandCompat;
module.exports.expand = expandCompat;
module.exports.EXPANSION_MAX = secureBraceExpansion.EXPANSION_MAX;
module.exports.EXPANSION_MAX_LENGTH = secureBraceExpansion.EXPANSION_MAX_LENGTH;
