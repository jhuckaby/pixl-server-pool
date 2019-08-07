// Worker Child Process Handler for pixl-server-pool
// Spawned via worker_proxy.js, runs in separate process
// Copyright (c) 2017 Joseph Huckaby
// Released under the MIT License

var Path = require('path');
var zlib = require('zlib');
var JSONStream = require("pixl-json-stream");
var Perf = require("pixl-perf");

// setup stdin / stdout streams 
process.stdin.setEncoding('utf8');
process.stdout.setEncoding('utf8');

// catch SIGINT and ignore (parent handles these)
process.on('SIGINT', function() {});

var worker = {
	
	config: null,
	user_obj: null,
	num_active_requests: 0,
	request_maint: false,
	request_shutdown: false,
	uriHandlers: [],
	
	run: function() {
		// startup child process
		var self = this;
		
		this.stream = new JSONStream( process.stdin, process.stdout );
		this.stream.on('json', this.receiveCommand.bind(this));
		
		process.on('SIGTERM', function() {
			// caught SIGTERM, which means the parent crashed
			var err = new Error("Caught SIGTERM: Emergency Pool Shutdown");
			err.code = 'SIGTERM';
			self.emergencyShutdown( err );
			process.exit(1);
		});
	},
	
	receiveCommand: function(req) {
		// receive data packet from parent
		switch (req.cmd) {
			case 'startup':
				for (var key in req) {
					if (key != 'cmd') this[key] = req[key];
				}
				this.startup();
			break;
			
			case 'request':
			case 'custom':
				this.handleRequest(req);
			break;
			
			case 'maint':
				this.maint(req.data || true);
			break;
			
			case 'message':
				this.handleMessage(req);
			break;
			
			case 'shutdown':
				this.shutdown();
			break;
		}
	},
	
	startup: function() {
		// load user code and allow it to startup async
		var self = this;
		
		// optionally gzip text content in the worker
		this.gzipEnabled = this.config.gzip_worker || false;
		this.gzipOpts = this.config.gzip_opts || { level: zlib.Z_DEFAULT_COMPRESSION, memLevel: 8 };
		this.gzipRegex = new RegExp( this.config.gzip_regex || '.+', "i" );
		
		// optionally listen for uncaught exceptions and shutdown
		if (this.server.uncatch) {
			require('uncatch').on('uncaughtException', function(err) {
				self.emergencyShutdown(err);
			});
		}
		
		// load user module
		this.user_obj = require(
			this.config.script.match(/^\//) ? this.config.script : Path.join(process.cwd(), this.config.script) 
		);
		
		// call user startup
		if (this.user_obj.startup) {
			this.user_obj.startup( this, function(err) {
				if (err) throw err;
				else self.sendCommand('startup_complete');
			} );
		}
		else this.sendCommand('startup_complete');
	},
	
	handleRequest: function(req) {
		// handle new incoming web request
		var self = this;
		var handler = null;
		
		// track active requests (for maint and shutdown)
		this.num_active_requests++;
		
		// track perf in child
		req.perf = new Perf();
		req.perf.begin();
		
		// decode base64 raw post buffer if present
		if ((req.type == 'base64') && req.params.raw) {
			req.params.raw = Buffer.from(req.params.raw, 'base64');
		}
		
		// prepare response, which child can modify
		var res = {
			id: req.id,
			status: "200 OK",
			type: 'string',
			headers: {},
			body: ''
		};
		req.response = res;
		
		// include mock request & socket & perf objects, to be more pixl-server-web compatible
		if (req.cmd == 'request') {
			req.request = {
				httpVersion: req.httpVersion,
				headers: req.headers,
				method: req.method,
				url: req.uri,
				socket: { remoteAddress: req.ip }
			};
			
			// decide if we need to call a custom URI handler or not
			var uri = req.request.url.replace(/\?.*$/, '');
			
			for (var idx = 0, len = this.uriHandlers.length; idx < len; idx++) {
				var matches = uri.match(this.uriHandlers[idx].regexp);
				if (matches) {
					req.matches = matches;
					handler = this.uriHandlers[idx];
					idx = len;
				}
			}
		} // request cmd
		
		// finish response and send to stdio pipe
		var finishResponse = function() {
			// copy perf metrics over to res
			if (!res.perf) res.perf = req.perf.metrics();
			
			// send response to parent
			self.sendCommand('response', res);
			
			// done with this request
			self.num_active_requests--;
			
			// if we're idle now, check for pending maint / shutdown requests
			if (!self.num_active_requests) {
				if (self.request_shutdown) self.shutdown();
				else if (self.request_maint) self.maint(self.request_maint);
			}
		};
		
		// handle response back from user obj
		var handleResponse = function() {
			// check for error as solo arg
			if ((arguments.length == 1) && (arguments[0] instanceof Error)) {
				res.status = "500 Internal Server Error";
				res.type = "string";
				res.body = "" + arguments[0];
				res.logError = {
					code: 500,
					msg: res.body
				};
			}
			else if (req.cmd == 'custom') {
				// custom request, pass body through
				res.type = 'passthrough';
				res.body = arguments[1] || res.body;
			}
			else {
				// check for pixl-server-web style callbacks
				if ((arguments.length == 1) && (typeof(arguments[0]) == 'object')) {
					// json
					res.body = arguments[0];
				}
				else if ((arguments.length == 3) && (typeof(arguments[0]) == "string")) {
					// status, headers, body
					res.status = arguments[0];
					res.headers = arguments[1] || {};
					res.body = arguments[2];
				}
				
				// set res type and massage body if needed
				if (res.body && (res.body instanceof Buffer)) {
					// base64 encode buffers
					res.type = 'base64';
					res.body = res.body.toString('base64');
				}
				else if (res.body && (typeof(res.body) == 'object')) {
					res.type = 'string';
					
					// stringify JSON here
					var json_raw = (req.query && req.query.pretty) ? JSON.stringify(res.body, null, "\t") : JSON.stringify(res.body);
					if (req.query && req.query.callback) {
						// JSONP
						res.body = req.query.callback + '(' + json_raw + ");\n";
						if (!res.headers['Content-Type']) res.headers['Content-Type'] = "text/javascript";
					}
					else {
						// pure JSON
						res.body = json_raw;
						if (!res.headers['Content-Type']) res.headers['Content-Type'] = "application/json";
					}
				}
			}
			
			// optional compress inside worker process
			if (
				self.gzipEnabled &&
				(res.status == '200 OK') && (res.type == 'string') &&
				res.body && res.body.length && req.headers && res.headers &&
				!res.headers['Content-Encoding'] && 
				(res.headers['Content-Type'] && res.headers['Content-Type'].match(self.gzipRegex)) && 
				(req.headers['accept-encoding'] && req.headers['accept-encoding'].match(/\bgzip\b/i))
			) 
			{
				// okay to gzip!
				req.perf.begin('gzip');
				zlib.gzip(res.body, self.gzipOpts, function(err, data) {
					req.perf.end('gzip');
					
					if (err) {
						// should never happen
						res.status = "500 Internal Server Error";
						res.body = "Failed to gzip compress content: " + err;
						res.logError = {
							code: 500,
							msg: res.body
						};
					}
					else {
						// no error, wrap in base64 for JSON
						res.type = 'base64';
						res.body = data.toString('base64');
						res.headers['Content-Encoding'] = 'gzip';
					}
					
					finishResponse();
				}); // gzip
			}
			else {
				// no gzip
				finishResponse();
			}
		}; // handleResponse
		
		// call custom URI handler, or the generic user_obj.handler()
		if (handler) handler.callback( req, handleResponse );
		else if (req.cmd == 'custom') this.user_obj.custom( req, handleResponse );
		else this.user_obj.handler( req, handleResponse );
	},
	
	handleMessage: function(req) {
		// received custom message from server
		if (this.user_obj.message) {
			this.user_obj.message( req.data );
		}
	},
	
	maint: function(user_data) {
		// perform routine maintenance
		var self = this;
		
		// make sure no requests are active
		if (this.num_active_requests) {
			this.request_maint = user_data || true;
			return;
		}
		this.request_maint = false;
		
		if (this.user_obj.maint) {
			// user has a maint() function, so call that
			this.user_obj.maint( user_data, function(err) {
				if (err) throw err;
				else self.sendCommand('maint_complete');
			} );
		}
		else if (global.gc) {
			// no user handler, so default to collecting garbage
			global.gc();
			this.sendCommand('maint_complete');
		}
		else {
			// nothing to do
			this.sendCommand('maint_complete');
		}
	},
	
	sendCommand: function(cmd, data) {
		// send command back to parent
		if (!data) data = {};
		data.cmd = cmd;
		this.stream.write(data);
	},
	
	sendMessage: function(data) {
		// send custom user message
		// separate out user data to avoid any chance of namespace collision
		this.sendCommand('message', { data: data });
	},
	
	addURIHandler: function(uri, name, callback) {
		// add custom handler for URI
		var self = this;
		
		if (typeof(uri) == 'string') {
			uri = new RegExp("^" + uri + "$");
		}
		
		this.uriHandlers.push({
			regexp: uri,
			name: name,
			callback: callback
		});
	},
	
	removeURIHandler: function(name) {
		// remove handler for URI given name
		this.uriHandlers = this.uriHandlers.filter( function(item) {
			return( item.name != name );
		} );
	},
	
	shutdown: function() {
		// exit child process when we're idle
		if (this.num_active_requests) {
			this.request_shutdown = true;
			return;
		}
		this.request_shutdown = false;
		
		// allow user code to run its own async shutdown routine
		if (this.user_obj.shutdown) {
			this.user_obj.shutdown( function() {
				process.exit(0);
			} );
		}
		else {
			process.exit(0);
		}
	},
	
	emergencyShutdown: function(err) {
		// emergency shutdown, due to crash
		if (this.user_obj && this.user_obj.emergencyShutdown) {
			this.user_obj.emergencyShutdown(err);
		}
		else if (this.user_obj && this.user_obj.shutdown) {
			this.user_obj.shutdown( function() { /* no-op */ } );
		}
		// Note: not calling process.exit here, because uncatch does it for us
	}
};

worker.run();
