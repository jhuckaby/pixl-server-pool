// Worker Pool Proxy for pixl-server-pool
// Copyright (c) 2017 - 2020 Joseph Huckaby
// Released under the MIT License

var fs = require('fs');
var os = require('os');
var cp = require('child_process');
var Path = require('path');
var async = require('async');
var Class = require("pixl-class");
var Tools = require("pixl-tools");
var Perf = require("pixl-perf");
var BinaryStream = require('./stream.js');

module.exports = Class.create({
	// WorkerProxy represents one single worker process, but runs in the parent process
	child: null,
	pid: 0,
	requests: null,
	num_requests_served: 0,
	num_active_requests: 0,
	max_requests_per_child: 0,
	last_maint: 0,
	state: '', // startup, active, maint, shutdown
	
	__construct: function(config, pool) {
		// class constructor
		this.config = config;
		this.pool = pool;
		this.logger = this.pool.logger;
		
		// if max_requests_per_child is an array, treat as random range
		if (Tools.isaArray(this.config.max_requests_per_child)) {
			var mrpc = this.config.max_requests_per_child;
			this.max_requests_per_child = mrpc[0] + Math.round( Math.random() * (mrpc[1] - mrpc[0]) );
		}
		else this.max_requests_per_child = this.config.max_requests_per_child;
		
		this.num_requests_served = 0;
		this.num_active_requests = 0;
		this.requests = {};
		this.state = 'startup';
	},
	
	getState: function() { return this.state; },
	
	startup: function(callback) {
		// launch child, callback when ready
		var self = this;
		this.logDebug(4, "Worker starting up" );
		
		var child_cmd = this.config.exec_path || process.execPath;
		
		var child_args = [];
		if (this.config.exec_path && this.config.exec_args) {
			// custom exec args
			child_args = this.config.exec_args;
		}
		else {
			// standard worker.js wrapper
			child_args = [].concat(
				process.execArgv,
				Path.join( __dirname, "worker.js" ),
				process.argv.slice(2)
			);
		}
		
		var child_opts = Tools.mergeHashes( {
			stdio: ["pipe", "pipe", "pipe"],
			env: Tools.mergeHashes( process.env, this.config.exec_env ),
			cwd: process.cwd(),
			uid: process.getuid(),
			gid: process.getgid()
		}, this.config.exec_opts );
		
		// spawn child
		try {
			this.child = cp.spawn( child_cmd, child_args, child_opts );
		}
		catch (err) {
			this.logError("child", "Child spawn error: " + err);
			return callback(err);
		}
		
		// setup two-way msgpack communication over stdio
		this.encodeStream = BinaryStream.createEncodeStream();
		this.encodeStream.pipe( this.child.stdin );
		
		this.decodeStream = BinaryStream.createDecodeStream();
		this.child.stdout.pipe( this.decodeStream );
		
		this.pid = this.child.pid;
		this.started = false;
		this.child_exited = false;
		this.last_maint = (this.config.maint_method == 'time') ? Tools.timeNow() : 0;
		
		// set a startup timeout if configured
		if (this.config.startup_timeout_sec) {
			this.startup_timer = setTimeout( function() {
				// startup max time exceeded, abort startup
				self.logError('child', "Child startup timeout: " + self.pid + " (" + self.config.startup_timeout_sec + " seconds)");
				self.child.kill('SIGKILL');
			}, this.config.startup_timeout_sec * 1000 );
		}
		
		this.decodeStream.on('data', function(data) {
			// received msgpack data from child
			if (!data.cmd) {
				self.logError('child', "Bad JSON message from child (missing cmd): " + self.pid, data);
				return;
			}
			
			if ((data.cmd == "startup_complete") && !self.started) {
				// complete startup
				if (self.startup_timer) {
					clearTimeout( self.startup_timer );
					delete self.startup_timer;
				}
				self.logDebug(5, "Worker " + self.pid + " startup complete, ready to serve");
				self.started = true;
				self.changeState('active');
				callback();
			}
			else self.handleChildResponse(data);
		} );
		
		this.decodeStream.on('error', function(err, text) {
			// Probably a msgpack decode error (child emitting garbage)
			self.logError('child', "Child stream error: " + self.pid + ": " + err);
		} );
		
		this.encodeStream.on('error', function(err, text) {
			// Probably a dead child that didn't register as dead yet
			self.logError('child', "Child stream error: " + self.pid + ": " + err);
		} );
		
		// listen on stderr as well (stack trace, etc.)
		this.child.stderr.setEncoding('utf8');
		this.child.stderr.on('data', function(data) {
			if (self.pool.manager.server.debug) process.stderr.write(''+data);
			else self.logError('child', "STDERR: " + self.pid + ": " + data);
		});
		
		this.child.on('error', function (err) {
			// child error (death)
			self.shut = true;
			self.changeState('shutdown');
			self.child_exited = true;
			
			var err_msg = Tools.getErrorDescription(err);
			self.logError("child", "Child process error: " + err_msg);
			self.abortAllRequests("Child Process Error: " + err_msg);
			self.pool.notifyWorkerExit( self, 1 );
			
			// cancel timers if applicable
			if (self.startup_timer) {
				clearTimeout( self.startup_timer );
				delete self.startup_timer;
			}
			if (self.kill_timer) {
				clearTimeout( self.kill_timer );
				delete self.kill_timer;
			}
			if (self.maint_timer) {
				clearTimeout( self.maint_timer );
				delete self.maint_timer;
			}
			
			// see if child exited before startup completed
			if (!self.started) {
				callback( new Error("Child " + self.pid + " exited during startup: " + err_msg) );
			}
		} );
		
		this.child.on('exit', function (code, signal) {
			// child exited
			self.shut = true;
			self.changeState('shutdown');
			self.child_exited = true;
			self.logDebug(4, "Child " + self.pid + " exited with code: " + (code || signal || 0));
			self.abortAllRequests("Child Process Exited: " + (code || signal || 0));
			self.pool.notifyWorkerExit( self, code );
			
			// cancel timers if applicable
			if (self.startup_timer) {
				clearTimeout( self.startup_timer );
				delete self.startup_timer;
			}
			if (self.kill_timer) {
				clearTimeout( self.kill_timer );
				delete self.kill_timer;
			}
			if (self.maint_timer) {
				clearTimeout( self.maint_timer );
				delete self.maint_timer;
			}
			
			// see if child exited before startup completed
			if (!self.started) {
				callback( new Error("Child " + self.pid + " exited during startup with code: " + (code || signal || 0)) );
			}
		} ); // on exit
		
		// send initial config to child
		this.encodeStream.write({
			cmd: 'startup', 
			config: this.config,
			server: {
				hostname: this.pool.manager.server.hostname,
				ip: this.pool.manager.server.ip,
				uncatch: this.pool.manager.uncatch
			}
		});
		
		this.logDebug(4, "Spawned new child process: " + this.pid, { cmd: child_cmd, args: child_args, script: this.config.script || 'n/a' });
	},
	
	delegateRequest: function(args, callback) {
		// create new serializable request object
		var data = {
			cmd: args.cmd || 'request',
			id: this.pool.manager.getUniqueID('r'),
			params: args.params
		};
		
		if (data.cmd == 'request') {
			// web request
			Tools.mergeHashInto(data, {
				ip: args.ip,
				ips: args.ips,
				method: args.request.method,
				headers: args.request.headers,
				httpVersion: args.request.httpVersion,
				uri: args.request.url,
				url: this.pool.manager.server.WebServer.getSelfURL(args.request, args.request.url),
				query: args.query,
				cookies: args.cookies,
				files: {}
			});
			
			// file uploads need to be copied over with care
			if (args.files) {
				for (var key in args.files) {
					var file = args.files[key];
					data.files[key] = {
						name: file.name,
						path: file.path,
						size: file.size,
						type: file.type
					};
				}
			}
			
			// args.params.raw may be Buffer (msgpack will encode it)
			if (data.params.raw) {
				data.type = 'buffer';
			}
		} // web request
		
		// keep track of request in parent, so we know how to send response
		this.requests[ data.id ] = {
			args: args,
			callback: callback,
			timer: this.config.request_timeout_sec ? 
				setTimeout( this.handleChildTimeout.bind(this, data.id), this.config.request_timeout_sec * 1000 ) : null
		};
		
		this.num_active_requests++;
		this.pool.num_active_requests++;
		
		this.logDebug(10, "Sending request to child: " + this.pid + " (Request ID: " + data.id + ")", data);
		
		if (args.perf) args.perf.begin('worker');
		
		// send request to child
		this.encodeStream.write( data );
	},
	
	delegateCustom: function(user_data, callback) {
		// send custom request into child, i.e. not web related
		var perf = new Perf();
		perf.begin();
		
		var args = {
			cmd: 'custom',
			params: user_data,
			perf: perf
		};
		
		this.delegateRequest( args, function(status, headers, body) {
			// convert web response to standard err/data/perf callback
			perf.end();
			
			if (status != "200 OK") {
				var err = new Error( body.toString() );
				err.code = status;
				callback( err, null, perf );
			}
			else {
				// success
				callback( null, body, perf );
			}
		} ); // delegateRequest
	},
	
	sendMessage: function(user_data) {
		// send custom user message to child
		if (this.encodeStream) {
			this.encodeStream.write({
				cmd: 'message',
				data: user_data || false
			});
		}
	},
	
	sendInternal: function(data) {
		// send internal command to child
		if (this.encodeStream) {
			this.encodeStream.write({
				cmd: 'internal',
				data: data || false
			});
		}
	},
	
	abortAllRequests: function(msg) {
		// abort all active requests (child died)
		if (!msg) msg = "Unknown Reason";
		
		for (var id in this.requests) {
			var req = this.requests[id];
			
			this.logError(500, "Aborted request: " + req.args.request.url + ": " + msg);
			
			this.handleChildResponse({
				id: id,
				status: "500 Internal Server Error",
				body: "500 Internal Server Error: Request Aborted"
			});
		}
		
		this.requests = {};
	},
	
	handleChildTimeout: function(id) {
		// child request took too long
		if (this.requests[id]) {
			delete this.requests[id].timer;
			var msg = "Worker request exceeded maximum allowed time of " + this.config.request_timeout_sec + " seconds.";
			this.logError(504, msg);
			
			this.handleChildResponse({
				id: id,
				status: "504 Gateway Timeout",
				body: "504 Gateway Timeout: " + msg
			});
		}
	},
	
	handleChildResponse: function(data) {
		// handle JSON response from child
		if (data.type != 'stream') {
			// for streams this has already been logged
			this.logDebug(10, "Got response from child: " + this.pid + " (Request ID: " + data.id + ")", data);
		}
		
		// check for special response type
		if (!data.cmd) data.cmd = 'response';
		switch (data.cmd) {
			case 'maint_complete':
				this.logDebug(4, "Maintenance complete on child: " + this.pid);
				if (this.maint_timer) {
					clearTimeout( this.maint_timer );
					delete this.maint_timer;
				}
				this.changeState('active');
				return;
			break;
			
			case 'message':
				// custom message from child, emit as event
				this.logDebug(10, "Received custom message from child: " + this.pid, data.data);
				data.pid = this.pid;
				this.emit('message', data);
				this.pool.emit('message', data);
				return;
			break;
			
			case 'internal':
				// internal command from child, emit as event
				this.logDebug(10, "Received internal response from child: " + this.pid, data.data);
				data.pid = this.pid;
				this.emit('internal', data);
				this.pool.emit('internal', data);
				return;
			break;
		} // switch cmd
		
		// locate request so we can send response
		var req = this.requests[ data.id ];
		if (!req) {
			this.logError('child', "Request not found: " + data.id);
			return;
		}
		
		// cancel timeout
		if (req.timer) {
			clearTimeout( req.timer );
			delete req.timer;
		}
		
		var args = req.args;
		var callback = req.callback;
		var body = data.body;
		
		switch (data.type) {
			case 'file':
				return this.sendFileResponse(data, req);
			break;
			
			case 'buffer':
				// body should be a buffer
			break;
			
			case 'stream':
				// body should be a stream
			break;
			
			case 'passthrough':
				// no touchy (custom response)
			break;
			
			case 'json':
				var json_raw = (args.query && args.query.pretty) ? JSON.stringify(body, null, "\t") : JSON.stringify(body);
				if (args.query && args.query.callback) {
					// JSONP
					body = args.query.callback + '(' + json_raw + ");\n";
					if (!data.headers['Content-Type']) data.headers['Content-Type'] = "text/javascript";
				}
				else {
					// pure JSON
					body = json_raw;
					if (!data.headers['Content-Type']) data.headers['Content-Type'] = "application/json";
				}
			break;
		}
		
		// log error if desired
		if (data.logError) {
			this.logError( data.logError.code, data.logError.msg, { request_id: data.id, worker: this.pid } );
		}
		
		if (args.perf) {
			args.perf.end('worker');
			
			// if child provided perf, merge it in
			if (data.perf) args.perf.import( data.perf );
		}
		
		// remove active request
		delete this.requests[ data.id ];
		
		this.num_requests_served++;
		this.num_active_requests--;
		this.pool.num_active_requests--;
		
		// fire original webserver callback which sends response to waiting client
		callback( data.status || "200 OK", data.headers || {}, body );
	},
	
	sendFileResponse: function(data, req) {
		// special case, send a file stream back
		var self = this;
		var file = data.body;
		
		fs.stat( file, function(err, stats) {
			if (err) {
				self.logError(500, "Could not stat file: " + file);
				
				return req.callback(
					"500 Internal Server Error", 
					{ 'Content-Type': "text/html" }, 
					"500 Internal Server Error: Could not stat file: " + file + "\n"
				);
			}
			
			if (!data.headers) data.headers = {};
			data.headers['Content-Length'] = stats.size;
			
			data.body = fs.createReadStream( file );
			data.type = 'stream';
			
			self.handleChildResponse( data );
			
			// optionally delete file (safe to do this after stream has opened)
			if (data.delete) {
				setTimeout( function() {
					fs.unlink( file, function(err) {
						if (err) {
							self.logError('child', "Unable to delete file: " + file + ": " + err );
						}
					} );
				}, 1 );
			}
		}); // fs.stat
	},
	
	maint: function(data) {
		// go into maintenance mode
		var self = this;
		
		this.logDebug(4, "Worker " + this.pid + " entering maintenance mode");
		this.logDebug(6, "Sending 'maint' command to process: " + this.pid);
		
		this.encodeStream.write({ cmd: 'maint', data: data || true });
		this.changeState('maint');
		
		// make sure maint doesn't take too long
		if (this.config.maint_timeout_sec) {
			this.maint_timer = setTimeout( function() {
				// maint timeout
				self.logError('maint', "Maintenance on worker: " + self.pid + " took longer than " + self.config.maint_timeout_sec + " seconds, killing worker");
				self.shutdown();
				delete self.maint_timer;
			}, this.config.maint_timeout_sec * 1000 );
		}
	},
	
	shutdown: function() {
		// shut down child
		var self = this;
		
		if (this.encodeStream) {
			this.logDebug(4, "Worker " + this.pid + " shutting down (" + this.num_requests_served + " requests served)");
			this.logDebug(6, "Sending 'shutdown' command to process: " + this.pid);
			
			this.encodeStream.write({ cmd: 'shutdown' });
			this.shut = true;
			this.changeState('shutdown');
			
			// we're done writing to the child -- don't hold open its stdin
			this.encodeStream.end();
			
			// start timer to make sure child exits
			this.kill_timer = setTimeout( function() {
				self.logError('child', "Child " + self.pid + " did not shutdown within " + self.config.shutdown_timeout_sec + " seconds, and will be killed");
				self.child.kill('SIGKILL');
			}, this.config.shutdown_timeout_sec * 1000 );
		}
	},
	
	changeState: function(new_state) {
		// change child state
		if (new_state != this.state) {
			this.logDebug(5, "Worker " + this.pid + " changing state from '" + this.state + "' to '" + new_state + "'");
			this.state = new_state;
			this.pool.notifyWorkerStateChange(this);
		}
	},
	
	logDebug: function(level, msg, data) {
		// proxy request to system logger with correct component
		this.pool.logDebug(level, msg, data);
	},
	
	logError: function(code, msg, data) {
		// proxy request to system logger with correct component
		this.pool.logError(code, msg, data);
	}
	
}); // WorkerProxy
