// Worker Child Process Handler for pixl-server-pool
// Spawned via worker_proxy.js, runs in separate process
// Copyright (c) 2017 - 2021 Joseph Huckaby
// Released under the MIT License

var Path = require('path');
var zlib = require('zlib');
var Perf = require('pixl-perf');
var Tools = require("pixl-tools");
var BinaryStream = require('./stream.js');

// catch SIGINT and ignore (parent handles these)
process.on('SIGINT', function() {});

var worker = {
	
	__name: 'PoolWorker',
	config: null,
	user_obj: null,
	num_active_requests: 0,
	request_maint: false,
	request_shutdown: false,
	uriHandlers: [],
	
	run: function() {
		// startup child process
		var self = this;
		
		// setup two-way msgpack communication over stdio
		this.encodeStream = BinaryStream.createEncodeStream();
		this.encodeStream.pipe( process.stdout );
		
		this.decodeStream = BinaryStream.createDecodeStream();
		process.stdin.pipe( this.decodeStream );
		
		this.decodeStream.on('data', this.receiveCommand.bind(this));
		
		process.on('SIGTERM', function() {
			// caught SIGTERM, which means the parent crashed
			var err = new Error("Caught SIGTERM: Emergency Pool Shutdown");
			err.code = 'SIGTERM';
			self.emergencyShutdown( err );
			process.exit(1);
		});
		
		// copy refs to global on inspector start
		this.globals = {
			worker: this
		};
	},
	
	attachLogAgent: function(logger) {
		// attach pixl-logger compatible log agent
		this.logger = logger;
	},
	
	addDebugGlobals: function(obj) {
		// add custom globals when debugger starts
		Tools.mergeHashInto( this.globals, obj );
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
			
			case 'internal':
				this.handleInternal(req);
			break;
			
			case 'shutdown':
				this.shutdown();
			break;
		}
	},
	
	startup: function() {
		// load user code and allow it to startup async
		var self = this;
		
		// optionally compress text content in the worker
		this.compEnabled = this.config.compress_child || this.config.gzip_child || false;
		this.compRegex = new RegExp( this.config.compress_regex || this.config.gzip_regex || '.+', "i" );
		this.gzipOpts = this.config.gzip_opts || {
			level: zlib.constants.Z_DEFAULT_COMPRESSION, 
			memLevel: 8 
		};
		
		this.brotliEnabled = !!zlib.BrotliCompress && this.config.brotli_child;
		this.brotliOpts = this.config.brotli_opts || {
			chunkSize: 16 * 1024,
			mode: 'text',
			level: 4
		};
		
		if (this.brotliEnabled) {
			if ("mode" in this.brotliOpts) {
				switch (this.brotliOpts.mode) {
					case 'text': this.brotliOpts.mode = zlib.constants.BROTLI_MODE_TEXT; break;
					case 'font': this.brotliOpts.mode = zlib.constants.BROTLI_MODE_FONT; break;
					case 'generic': this.brotliOpts.mode = zlib.constants.BROTLI_MODE_GENERIC; break;
				}
				if (!this.brotliOpts.params) this.brotliOpts.params = {};
				this.brotliOpts.params[ zlib.constants.BROTLI_PARAM_MODE ] = this.brotliOpts.mode;
				delete this.brotliOpts.mode;
			}
			if ("level" in this.brotliOpts) {
				if (!this.brotliOpts.params) this.brotliOpts.params = {};
				this.brotliOpts.params[ zlib.constants.BROTLI_PARAM_QUALITY ] = this.brotliOpts.level;
				delete this.brotliOpts.level;
			}
			if ("hint" in this.brotliOpts) {
				if (!this.brotliOpts.params) this.brotliOpts.params = {};
				this.brotliOpts.params[ zlib.constants.BROTLI_PARAM_SIZE_HINT ] = this.brotliOpts.hint;
				delete this.brotliOpts.hint;
			}
		} // brotli
		
		this.acceptEncodingMatch = this.brotliEnabled ? /\b(gzip|deflate|br)\b/i : /\b(gzip|deflate)\b/i;
		
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
		
		// expose user app in globals for debugger
		this.addDebugGlobals({ app: this.user_obj });
		
		// call user startup
		if (this.user_obj.startup) {
			this.user_obj.startup( this, function(err) {
				if (err) throw err;
				else {
					self.logDebug(3, "Worker starting up");
					self.sendCommand('startup_complete');
				}
			} );
		}
		else {
			this.logDebug(3, "Worker starting up");
			this.sendCommand('startup_complete');
		}
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
		
		// handle request timeout in worker as well
		var timed_out = false;
		var timer = ((req.cmd == 'request') && this.config.request_timeout_sec) ? setTimeout( function() {
			timed_out = true;
			timer = null;
			req.aborted = true;
			
			self.logError('timeout', "Request timed out: " + req.uri + " (" + self.config.request_timeout_sec + " sec)", {
				id: req.id,
				method: req.method,
				url: req.uri,
				ips: req.ips,
				headers: req.headers,
				perf: req.perf.metrics()
			} );
			
			// done with this request
			self.num_active_requests--;
			
			// if we're idle now, check for pending maint / shutdown requests
			if (!self.num_active_requests) {
				if (self.request_shutdown) self.shutdown();
				else if (self.request_maint) self.maint(self.request_maint);
			}
		}, this.config.request_timeout_sec * 1000 ) : null;
		
		// finish response and send to stdio pipe
		var finishResponse = function() {
			// copy perf metrics over to res
			if (!res.perf) res.perf = req.perf.metrics();
			
			// send response to parent
			res.cmd = 'response';
			self.encodeStream.write(res);
			
			// done with this request
			self.num_active_requests--;
			
			// if we're idle now, check for pending maint / shutdown requests
			if (!self.num_active_requests) {
				if (self.request_shutdown) self.shutdown();
				else if (self.request_maint) self.maint(self.request_maint);
			}
		};
		
		// support for SSE
		req.sse = {
			send: function(chunk) {
				// send SSE message, e.g. { id:1, event:update, data:{foo:bar} }
				if (!chunk || !chunk.data) throw new Error("Must pass chunk with data to sse.send()");
				self.sendCommand('sse', { id: req.id, chunk });
				req.sse.enabled = true;
			},
			end: function() {
				// signal end of SSE request
				if (timed_out || !req.sse.enabled) return;
				if (timer) { clearTimeout(timer); timer = null; }
				res.type = 'sse';
				res.body = '';
				finishResponse();
			}
		}; // sse
		
		// handle response back from user obj
		var handleResponse = function() {
			// check for timeout first
			if (req.sse.enabled) return req.sse.end();
			if (timed_out) return;
			if (timer) { clearTimeout(timer); timer = null; }
			
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
					// buffers survive msgpack
					res.type = 'buffer';
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
				self.compEnabled &&
				(res.status == '200 OK') && (res.type == 'string') &&
				res.body && res.body.length && req.headers && res.headers &&
				!res.headers['Content-Encoding'] && 
				(res.headers['Content-Type'] && res.headers['Content-Type'].match(self.compRegex)) && 
				(req.headers['accept-encoding'] && req.headers['accept-encoding'].match(self.acceptEncodingMatch))
			) 
			{
				// okay to compress!
				req.perf.begin('compress');
				
				var zlib_opts = null;
				var zlib_func = '';
				var accept_encoding = req.headers['accept-encoding'].toLowerCase();
				
				if (self.brotliEnabled && accept_encoding.match(/\b(br)\b/)) {
					// prefer brotli first, if supported by Node.js
					zlib_func = 'brotliCompress';
					zlib_opts = self.brotliOpts || {};
					res.headers['Content-Encoding'] = 'br';
				}
				else if (accept_encoding.match(/\b(gzip)\b/)) {
					// prefer gzip second
					zlib_func = 'gzip';
					zlib_opts = self.gzipOpts || {};
					res.headers['Content-Encoding'] = 'gzip';
				}
				else if (accept_encoding.match(/\b(deflate)\b/)) {
					// prefer deflate third
					zlib_func = 'deflate';
					zlib_opts = self.gzipOpts || {}; // yes, same opts as gzip
					res.headers['Content-Encoding'] = 'deflate';
				}
				
				zlib[ zlib_func ]( res.body, zlib_opts, function(err, data) {
					req.perf.end('compress');
					
					if (err) {
						// should never happen
						res.status = "500 Internal Server Error";
						res.body = "Failed to compress content: " + err;
						res.logError = {
							code: 500,
							msg: res.body
						};
					}
					else {
						// no error, send as buffer (msgpack)
						res.type = 'buffer';
						res.body = data;
					}
					
					finishResponse();
				}); // compress
			}
			else {
				// no compress
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
	
	handleInternal: function(req) {
		// received internal command from server
		var data = req.data || {};
		switch (data.action) {
			case 'start_debug': this.startDebug(data); break;
			case 'stop_debug': this.stopDebug(data); break;
			case 'update_debug': this.updateDebug(data); break;
		}
	},
	
	startDebug: function(data) {
		// start debugger
		this.origDebugLevel = this.logger ? this.logger.get('debugLevel') : 0;
		
		if (!this.inspector) {
			this.inspector = require('inspector');
		}
		
		if (!this.inspector.url()) {
			var host = data.host || '0.0.0.0';
			var port = data.port || 9229;
			this.logDebug(2, "Opening debug inspector port " + port);
			this.inspector.open( port, host );
		}
		
		var url = this.inspector.url();
		this.logDebug(5, "Inspector URL: " + url);
		
		url = url.replace(/^(\w+\:\/\/)([\w\-\.]+)(.+)$/, '$1' + this.server.ip + '$3');
		this.logDebug(5, "Swapping in LAN IP: " + url);
		
		url = url.replace(/^\w+\:\/\//, 'devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=');
		this.logDebug(5, "Wrapping in devtools proto: " + url);
		
		// inform parent debugger has started
		this.sendCommand( 'internal', { 
			action: 'debug_started', 
			url: url,
			pid: process.pid,
			echo: this.logger ? this.logger.get('echo') : false,
			debugLevel: this.origDebugLevel
		});
		
		// infuse globals for easy access from inspector
		Tools.mergeHashInto( global, this.globals );
		
		this.inspector.console.log("%cNode.js Remote Debugger has started.", "color:green; font-family:sans-serif; font-size:20px");
		this.inspector.console.log("%c" + this.config.id + " Pool Worker (PID " + process.pid + ")", "color:green; font-family:sans-serif;");
		this.inspector.console.log("%cCustom globals available: " + Object.keys(this.globals).sort().join(', '), "color:green; font-family:sans-serif;");
	},
	
	stopInspector: function() {
		// shut down inspector listener
		if (this.inspector) {
			this.logDebug(2, "Shutting down debug inspector");
			if (this.logger) {
				this.logger.set('echo', false);
				this.logger.echoer = null;
				this.logger.set('debugLevel', this.origDebugLevel);
				delete this.origDebugLevel;
			}
			this.inspector.close();
			delete this.inspector;
			
			// remove globals we added
			for (var key in this.globals) {
				delete global[key];
			}
		}
	},
	
	stopDebug: function(data) {
		// stop debugger
		this.stopInspector();
	},
	
	updateDebug: function(data) {
		// enable/disable log mirror, change log level
		// data: { echo, level, match }
		var self = this;
		if (!this.logger) return; // sanity
		this.logDebug(5, "Changing debug log settings", data);
		
		try {
			this.logger._echoMatch = new RegExp( data.match || '.+' );
		}
		catch (err) {
			this.logError('regexp', "Invalid regular expression for log match: " + data.match + ": " + err);
			this.logger._echoMatch = /.+/;
		}
		
		if (data.echo && (parseInt(data.echo) != 0)) {
			this.logDebug(5, "Activating log inspector echo mirror");
			this.logger.echoer = function(line, cols, args) {
				if (self.inspector && self.inspector.console && line.match(self.logger._echoMatch)) {
					self.inspector.console.log( line );
				}
			};
			this.logger.set('echo', true);
		}
		else {
			this.logger.set('echo', false);
			this.logger.echoer = null;
		}
		
		if (data.level) {
			this.logger.set('debugLevel', parseInt(data.level));
		}
	},
	
	maint: function(user_data) {
		// perform routine maintenance
		var self = this;
		this.logDebug(5, "Performing worker maintenance");
		
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
		// merge cmd in with data (clobbers!)
		if (!data) data = {};
		data.cmd = cmd;
		this.logDebug(9, "Sending command to parent: " + cmd, data);
		this.encodeStream.write(data);
	},
	
	sendMessage: function(data) {
		// send custom user message
		// separate out user data to avoid any chance of namespace collision
		this.encodeStream.write({ cmd: 'message', data: data });
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
	
	logDebug: function(level, msg, data) {
		// proxy request to system logger with correct component
		if (!this.logger) return;
		
		if (level <= this.logger.get('debugLevel')) {
			this.logger.set( 'component', this.__name );
			this.logger.print({ 
				category: 'debug', 
				code: level, 
				msg: msg, 
				data: data 
			});
		}
	},
	
	logError: function(code, msg, data) {
		// proxy request to system logger with correct component
		if (!this.logger) return;
		this.logger.set( 'component', this.__name );
		this.logger.error( code, msg, data );
	},
	
	logTransaction: function(code, msg, data) {
		// proxy request to system logger with correct component
		if (!this.logger) return;
		this.logger.set( 'component', this.__name );
		this.logger.transaction( code, msg, data );
	},
	
	shutdown: function() {
		// exit child process when we're idle
		this.logDebug(2, "Shutting down worker");
		this.stopInspector();
		
		if (this.num_active_requests) {
			this.logDebug(2, this.num_active_requests + " requests still active, shutdown will be delayed.");
			this.request_shutdown = true;
			return;
		}
		this.request_shutdown = false;
		
		// close encode stream
		this.encodeStream.end();
		
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
		this.logDebug(1, "Emergency Worker Shutdown: " + err);
		this.stopInspector();
		
		if (this.user_obj && this.user_obj.emergencyShutdown) {
			this.user_obj.emergencyShutdown(err);
		}
		else if (this.user_obj && this.user_obj.shutdown) {
			this.user_obj.shutdown( function() { /* no-op */ } );
		}
		// Note: not calling process.exit here, because uncatch does it for us
	}
};

// redirect console._stdout, as it will interfere with msgpack
console._stdout = console._stderr;

worker.run();
