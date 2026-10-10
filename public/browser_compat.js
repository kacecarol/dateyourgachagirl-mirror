(function () {
  if (!Object.fromEntries) Object.fromEntries = function (entries) {
    var result = {}; entries.forEach(function (entry) { Object.defineProperty(result, entry[0], {value:entry[1],enumerable:true,writable:true,configurable:true}); }); return result;
  };
  if (!window.structuredClone) window.structuredClone = function (value) { return JSON.parse(JSON.stringify(value)); };
  if (!String.prototype.replaceAll) String.prototype.replaceAll = function (search, replacement) { return String(this).split(search).join(replacement); };
  if (window.crypto && !crypto.randomUUID) crypto.randomUUID = function () {
    var bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
  };
})();
