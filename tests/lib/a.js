'use strict';
exports.this = this;
exports.strict = (function (a) { a=2; return a!==arguments[0] })(1);
