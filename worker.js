// Worker Child Process Handler for pixl-server-pool
// Spawned via worker_proxy.js, runs in separate process
// Copyright (c) 2017 Joseph Huckaby
// Released under the MIT License

var Path = require('path');
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
		this.stream = new JSONStream( process.stdin, process.stdout );
		this.stream.on('json', this.receiveCommand.bind(this));
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
		this.user_obj = require(
			this.config.script.match(/^\//) ? this.config.script : Path.join(process.cwd(), this.config.script) 
		);
		
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
					res.type = 'json';
				}
			}
			
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
		
		// call custom URI handler, or the generic user_obj.handler()
		if (handler) handler( req, handleResponse );
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
	}
	
};

worker.run();
