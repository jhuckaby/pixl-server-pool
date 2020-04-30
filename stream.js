// A simple stream wrapper around msgpack-lite with error checking
// Allows for binary streams (much faster than JSON with binary buffers of 100K+)

var pumpify = require('pumpify');
var through = require('through2');
var lpStream = require('length-prefixed-stream');
var msgpack = require('msgpack-lite');

module.exports.createEncodeStream = function(stream) {
	var msgEncode = through.obj( function(data, enc, next) {
		var buf = null;
		try { buf = msgpack.encode(data); }
		catch (err) { return next(err); }
		next(null, buf);
	});
	
	return pumpify.obj(msgEncode, lpStream.encode());
};

module.exports.createDecodeStream = function(stream) {
	var msgDecode = through.obj( function(buf, enc, next) {
		var data = null;
		try { data = msgpack.decode(buf); }
		catch (err) { return next(err); }
		next(null, data);
	});
	
	return pumpify.obj(lpStream.decode(), msgDecode);
};
