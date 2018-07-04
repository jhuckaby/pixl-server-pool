// Worker Pool Manager for pixl-server
// Copyright (c) 2017 Joseph Huckaby
// Released under the MIT License

var async = require('async');
var Class = require("pixl-class");
var Tools = require("pixl-tools");
var Perf = require("pixl-perf");

var WorkerProxy = require('./worker_proxy.js');

module.exports = Class.create({
	// WorkerPool represents one group of workers
	workers: null,
	maint_roll: null,
	num_active_requests: 0,
	
	defaultConfig: {
		enabled: true,
		script: '',
		exec_path: '',
		exec_args: [],
		exec_env: {},
		exec_opts: {},
		min_children: 1,
		max_children: 1,
		max_concurrent_requests: 0,
		max_requests_per_child: 0, // can be array
		max_concurrent_launches: 1,
		max_concurrent_maint: 1,
		child_headroom_pct: 0,
		child_busy_factor: 1,
		startup_timeout_sec: 0,
		shutdown_timeout_sec: 10,
		request_timeout_sec: 0,
		maint_timeout_sec: 0,
		auto_maint: false,
		maint_method: 'requests',
		maint_requests: 1000,
		maint_time_sec: 0,
		uri_match: '',
		acl: false
	},
	
	__construct: function(config, manager) {
		// class constructor
		this.config = config;
		
		if (this.defaultConfig) {
			for (var key in this.defaultConfig) {
				if (typeof(this.config[key]) == 'undefined') {
					this.config[key] = this.defaultConfig[key];
				}
			}
		}
		
		this.manager = manager;
		this.logger = this.manager.logger;
		this.workers = {};
		this.maint_roll = {};
		this.num_active_requests = 0;
	},
	
	startup: function(callback) {
		// start initial workers
		var self = this;
		this.logDebug(2, "Starting up pool", this.config);
		
		async.timesLimit( this.config.min_children, this.config.max_concurrent_launches,
			function(idx, callback) {
				self.addWorker( callback );
			},
			function(err) {
				if (err) return callback(err);
				self.logDebug(2, "Pool startup complete");
				callback();
			}
		); // times
	},
	
	addWorker: function(callback) {
		// add new worker to pool
		var self = this;
		var worker = new WorkerProxy( this.config, this );
		
		worker.startup( function(err) {
			if (err) {
				self.logError('child', "Failed to start worker: " + err);
			}
			if (callback) callback(err);
		} );
		
		this.workers[ worker.pid ] = worker;
		this.notifyWorkerStateChange(worker);
		
		return worker;
	},
	
	getWorker: function(pid) {
		// get direct access to worker proxy via pid
		return this.workers[ pid ];
	},
	
	getWorkers: function() {
		// get all workers
		return this.workers;
	},
	
	delegateRequest: function(args, callback) {
		// delegate web request to one of our children
		if (this.config.max_concurrent_requests && (this.num_active_requests >= this.config.max_concurrent_requests)) {
			var msg = "Pool " + this.config.id + " is serving maximum of " + this.config.max_concurrent_requests + " concurrent requests.";
			this.logError( 429, msg, args.request ? { ips: args.ips, uri: args.request.url, headers: args.request.headers } : null );
			
			return callback(
				"429 Too Many Requests", 
				{ 'Content-Type': "text/html" }, 
				"429 Too Many Requests: " + msg + "\n"
			);
		} // HTTP 429
		
		// child picker: find all active workers serving the least # of concurrent requests
		// then pick one random worker from that subset
		var min_concurrent = 9999999;
		
		for (var pid in this.workers) {
			var worker = this.workers[pid];
			if ((worker.state == 'active') && (worker.num_active_requests < min_concurrent)) {
				min_concurrent = worker.num_active_requests;
			}
		}
		
		var chosen_few = [];
		for (var pid in this.workers) {
			var worker = this.workers[pid];
			if ((worker.state == 'active') && (worker.num_active_requests == min_concurrent)) {
				chosen_few.push(worker);
			}
		}
		
		if (!chosen_few.length) {
			// this should never happen
			var msg = "Pool " + this.config.id + " has no workers available to service requests.";
			this.logError( 503, msg, args.request ? { ips: args.ips, uri: args.request.url, headers: args.request.headers } : null );
			
			return callback(
				"503 Service Unavailable", 
				{ 'Content-Type': "text/html" }, 
				"503 Service Unavailable: " + msg + "\n"
			);
		}
		
		var chosen_one = Tools.randArray(chosen_few);
		this.logDebug(9, "Chose worker: " + chosen_one.pid + " for request: " + 
			((args.cmd == 'custom') ? '(internal)' : args.request.url) );
		
		chosen_one.delegateRequest(args, callback);
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
		// send custom user message to all workers in pool
		this.logDebug(9, "Sending custom message to all workers in pool", user_data);
		
		for (var pid in this.workers) {
			var worker = this.workers[pid];
			worker.sendMessage( user_data );
		}
	},
	
	requestMaint: function(data) {
		// request a rolling maint of all workers in pool
		this.logDebug(4, "Beginning rolling maintenance of all workers in pool");
		for (var pid in this.workers) {
			var worker = this.workers[pid];
			worker.request_maint = data || true;
		}
	},
	
	requestRestart: function() {
		// request a rolling restart of all workers in pool
		this.logDebug(4, "Beginning rolling restart of all workers in pool");
		for (var pid in this.workers) {
			var worker = this.workers[pid];
			worker.request_restart = true;
		}
	},
	
	getStates: function() {
		// get all worker state counts
		var states = { startup: 0, active: 0, maint: 0, shutdown: 0 };
		for (var pid in this.workers) {
			var worker = this.workers[pid];
			if (!states[worker.state]) states[worker.state] = 0;
			states[worker.state]++;
		}
		return states;
	},
	
	tick: function() {
		// run child maintenance, called every tick (1 sec)
		var now = Tools.timeNow();
		
		// make sure only N children do maint concurrently
		var states = this.getStates();
		
		// find worker to focus on (new worker each time, then loop around)
		var worker = null;
		
		for (var pid in this.workers) {
			if (!this.maint_roll[pid]) {
				this.maint_roll[pid] = 1;
				worker = this.workers[pid];
				break;
			}
		}
		if (!worker) {
			this.maint_roll = {};
			worker = this.workers[ Tools.firstKey(this.workers) ];
		}
		
		if (worker) {
			var need_maint = false;
			
			// sanity check: need at least 2 active children to perform maint
			if ((states.maint < this.config.max_concurrent_maint) && (states.active > 1)) {
				// check if it's time for auto maint
				if ((worker.state == 'active') && this.config.auto_maint) {
					switch (this.config.maint_method) {
						case 'requests':
							if (worker.num_requests_served - worker.last_maint >= this.config.maint_requests) {
								worker.last_maint = worker.num_requests_served;
								need_maint = true;
							}
						break;
						
						case 'time':
							if (now - worker.last_maint >= this.config.maint_time_sec) {
								worker.last_maint = now;
								need_maint = true;
							}
						break;
					}
				} // auto_maint
				
				// check for user maint request
				if ((worker.state == 'active') && worker.request_maint) {
					need_maint = worker.request_maint;
					delete worker.request_maint;
				}
				
				if (need_maint) {
					this.logDebug(3, "Peforming maintenance on worker: " + worker.pid);
					worker.maint(need_maint);
					
					states.active--;
					states.maint++;
					
					this.emit('maint', worker);
				}
			} // room for maint
			
			// make sure only N children are restarting at once
			if (states.startup + states.shutdown < this.config.max_concurrent_launches) {
				// check for end of life
				if ((worker.state == 'active') && worker.max_requests_per_child && (states.active > 1)) {
					if (worker.num_requests_served >= worker.max_requests_per_child) {
						this.logDebug(3, "Worker " + worker.pid + " has served " + worker.num_requests_served + " requests, and will be recycled");
						worker.shutdown();
						
						states.active--;
						states.shutdown++;
						
						this.emit('restart', worker);
					} // end of life
				} // max_requests_per_child
				
				// rolling restart request
				if ((worker.state == 'active') && worker.request_restart && (states.active > 1)) {
					delete worker.request_restart;
					this.logDebug(3, "Restarting worker " + worker.pid + " upon request");
					worker.shutdown();
					
					states.active--;
					states.shutdown++;
					
					this.emit('restart', worker);
				} // rolling restart
			} // room for restart
			
		} // found worker
		
		// now perform general pool maint:
		// automatically spawn / kill children as needed based on usage and headroom
		var num_busy = 0;
		var total_children = 0;
		var idle_kids = {};
		
		for (var pid in this.workers) {
			var worker = this.workers[pid];
			if (worker.state == 'active') {
				if (worker.num_active_requests >= this.config.child_busy_factor) num_busy++;
				else if (!worker.num_active_requests) idle_kids[pid] = 1;
			}
			total_children++;
		}
		
		// apply headroom adjustment
		var num_busy_adj = Math.floor( num_busy + (num_busy * (this.config.child_headroom_pct / 100)) );
		if (num_busy_adj < this.config.min_children - 1) num_busy_adj = this.config.min_children - 1;
		
		// count all children except those in maint or being shut down
		var num_children = states.startup + states.active;
		var total_sans_shut = total_children - states.shutdown;
		
		if ((num_busy_adj >= num_children) && (states.startup < this.config.max_concurrent_launches) && (total_sans_shut < this.config.max_children)) {
			// need more workers
			this.logDebug(4, "Auto-Scale: Adding worker to pool", { num_busy: num_busy });
			var worker = this.addWorker();
			this.emit('autoscale', { cmd: 'add', pid: worker.pid });
		}
		else if ((num_busy_adj < states.active - 1) && (states.active > 1) && (total_children > this.config.min_children)) {
			// need fewer workers
			var pid = Tools.firstKey(idle_kids);
			if (pid) {
				var worker = this.workers[pid];
				this.logDebug(4, "Auto-Scale: Removing idle worker: " + worker.pid, { num_busy: num_busy });
				worker.shutdown();
				this.emit('autoscale', { cmd: 'remove', pid: worker.pid });
			}
		}
	},
	
	notifyWorkerStateChange: function(worker) {
		// receive notification that a worker has changed its state
		// log all worker state counts
		var states = {};
		for (var pid in this.workers) {
			var worker = this.workers[pid];
			if (!states[worker.state]) states[worker.state] = 0;
			states[worker.state]++;
		}
		if (Tools.numKeys(states)) {
			this.logDebug(5, "Current worker states", states);
		}
	},
	
	notifyWorkerExit: function(worker) {
		// receive notification that a worker process exited
		this.logDebug(4, "Worker " + worker.pid +  " has been removed from the pool");
		delete this.workers[ worker.pid ];
		this.notifyWorkerStateChange(worker);
	},
	
	shutdown: function(callback) {
		// shutdown all workers in pool
		var self = this;
		this.logDebug(2, "Shutting down pool: " + this.config.id);
		
		Object.keys(this.workers).forEach( function(pid) {
			self.workers[pid].shutdown();
		} );
		
		// wait for all workers to exit
		async.whilst(
			function() { return !!Object.keys(self.workers).length; },
			function(callback) { setTimeout( callback, 100 ); },
			function() {
				self.logDebug(2, "All workers exited, pool shutdown complete");
				callback();
			}
		); // whilst
	},
	
	logDebug: function(level, msg, data) {
		// proxy request to system logger with correct component
		this.logger.set( 'component', 'Pool-' + this.config.id );
		this.logger.debug( level, msg, data );
	},
	
	logError: function(code, msg, data) {
		// proxy request to system logger with correct component
		this.logger.set( 'component', 'Pool-' + this.config.id );
		this.logger.error( code, msg, data );
	}
	
}); // WorkerPool
