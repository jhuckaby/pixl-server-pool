// Test Worker Child

var fs = require('fs');
var crypto = require('crypto');

module.exports = {
	
	startup: function(worker, callback) {
		// child is starting up
		this.worker = worker;
		callback();
	},
	
	handler: function(req, callback) {
		// handle web request
		var res = req.response;
		
		switch (req.query.type) {
			case 'json':
				// send back json
				res.type = 'json';
				res.body = {
					code: 0,
					description: "Success",
					user: { Name: "Joe", Email: "foo@bar.com" },
					params: req.params,
					query: req.query,
					cookies: req.cookies,
					files: req.files,
					headers: req.headers,
					pid: process.pid
				};
				
				// if we received a binary buffer, don't echo it back, just send info
				if (req.params.raw) {
					var buf = req.params.raw;
					delete req.params.raw;
					
					req.params.len = buf.length;
					req.params.digest = this.digestHex( buf );
				}
			break;
			
			case 'buffer':
				// send back binary buffer
				res.type = 'base64';
				res.headers['Content-Type'] = "image/gif";
				res.body = fs.readFileSync('spacer.gif');
			break;
			
			case 'file':
				// send back file on disk
				res.type = 'file';
				res.headers['Content-Type'] = "image/gif";
				res.body = 'spacer.gif';
			break;
			
			case 'string':
				// send back string
				res.type = 'string';
				res.headers['Content-Type'] = "text/html";
				res.body = fs.readFileSync('index.html', 'utf8');
			break;
			
			case 'error':
				return callback( new Error("SIMULATING ERROR FROM CHILD: " + process.pid) );
			break;
			
			case 'redirect':
				res.status = "302 Found";
				res.type = "string";
				res.headers['Location'] = "http://myserver.com/redirected";
				res.body = "Simulating HTTP 302 redirect in child: " + process.pid;
			break;
			
			default:
				return callback( new Error("BAD TYPE PARAM: " + req.query.type) );
			break;
		}
		
		var sleep_ms = parseInt( req.query.sleep || 0 );
		setTimeout( function() {
			callback();
		}, sleep_ms );
	},
	
	custom: function(req, callback) {
		// handle custom request
		return callback( null, {
			code: 0,
			description: "Success",
			user: { Name: "Joe", Email: "foo@bar.com" },
			params: req.params,
			pid: process.pid
		} );
	},
	
	message: function(data) {
		// custom message sent by parent
		// echo it back with addendum
		data.ADDED_BY_CHILD = process.pid;
		this.worker.sendMessage( data );
	},
	
	maint: function(user_data, callback) {
		// perform maintenance (gc, etc.)
		var self = this;
		if (user_data === true) user_data = {};
		
		setTimeout( function() {
			user_data.MAINT_COMPLETE = 1;
			self.worker.sendMessage(user_data);
			callback(); 
		}, 100 );
	},
	
	shutdown: function(callback) {
		// child is shutting down
		setTimeout( function() { callback(); }, 1 );
	},
	
	//
	// UTILITY METHODS:
	//
	
	digestHex: function(str, algo) {
		// digest string using SHA256 (by default), return hex hash
		var shasum = crypto.createHash( algo || 'sha256' );
		shasum.update( str );
		return shasum.digest('hex');
	}
	
};
