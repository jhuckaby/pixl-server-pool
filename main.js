// pixl-server-pool - Worker Pool Manager
// Copyright (c) 2017 Joseph Huckaby
// Released under the MIT License

var async = require('async');
var Class = require("pixl-class");
var Component = require("pixl-server/component");
var Tools = require("pixl-tools");

var WorkerPool = require('./worker_pool.js');

module.exports = Class.create({
	
	__name: 'PoolManager',
	__parent: Component,
	
	version: require( __dirname + '/package.json' ).version,
	
	defaultConfig: {
		ticks: true,
		startup_threads: 1,
		uncatch: false
	},
	
	worker_pools: null,
	uncatch: false,
	
	startup: function(callback) {
		// start worker pool system
		var self = this;
		this.worker_pools = {};
		this.logDebug(3, "pixl-server-pool v" + this.version + " starting up");
		
		// optionally kill all children on uncaught exception
		if (this.config.get('uncatch')) {
			this.uncatch = true;
			
			require('uncatch').on('uncaughtException', function(err) {
				self.logger.set('sync', true);
				self.logDebug(1, "Uncaught Exception: " + err);
				self.emergencyShutdown();
			});
		}
		
		// listen for tick events to manage children
		if (this.config.get('ticks')) {
			this.server.on( 'tick', this.tick.bind(this) );
		}
		
		var wp_config = this.config.get('pools');
		if (wp_config) {
			for (var pool_key in wp_config) {
				var pool_config = wp_config[pool_key];
				if (!("enabled" in pool_config) || pool_config.enabled) {
					pool_config.id = pool_key;
					var pool = new WorkerPool(pool_config, this);
					this.worker_pools[pool_key] = pool;
				} // pool enabled
			} // foreach pool
		} // got pools
		
		var pool_keys = Object.keys(this.worker_pools);
		if (pool_keys.length) {
			// start all pools in series / parallel
			async.eachLimit( pool_keys, this.config.get('startup_threads') || 1,
				function(pool_key, callback) {
					var pool = self.worker_pools[pool_key];
					
					if (pool.config.uri_match) {
						// optional: auto-activate pool on URI match
						self.server.WebServer.addURIHandler(
							(pool.config.uri_match instanceof RegExp) ? pool.config.uri_match : (new RegExp(pool.config.uri_match)),
							pool_key,
							pool.config.acl || false,
							function(args, callback) {
								pool.delegateRequest(args, callback);
							}
						);
					} // uri_match
					
					pool.startup( callback );
				},
				callback
			); // each
		}
		else callback();
	},
	
	createPool: function(pool_key, pool_config, callback) {
		// create new pool on-demand
		if (this.getPool(pool_key)) {
			return callback( new Error("Cannot add Pool: Key already in use: " + pool_key) );
		}
		
		pool_config.id = pool_key;
		
		var pool = new WorkerPool(pool_config, this);
		this.worker_pools[pool_key] = pool;
		
		if (pool.config.uri_match) {
			// optional: auto-activate pool on URI match
			this.server.WebServer.addURIHandler(
				(pool.config.uri_match instanceof RegExp) ? pool.config.uri_match : (new RegExp(pool.config.uri_match)),
				pool_key,
				pool.config.acl || false,
				function(args, callback) {
					pool.delegateRequest(args, callback);
				}
			);
		} // uri_match
		
		pool.startup( callback );
	},
	
	removePool: function(pool_key, callback) {
		// shut down and remove pool
		var self = this;
		var pool = this.getPool(pool_key);
		if (!pool) return callback( new Error("Cannot find Pool: " + pool_key) );
		
		if (pool.config.uri_match) {
			// remove URI match from pixl-server-web
			this.server.WebServer.removeURIHandler( pool_key );
		}
		
		pool.shutdown( function() {
			delete self.worker_pools[pool_key];
			callback();
		} );
	},
	
	getPool: function(pool_key) {
		// get direct access to pool given its key
		return this.worker_pools[pool_key];
	},
	
	_uniqueIDCounter: 0,
	getUniqueID: function(prefix) {
		// generate unique id using high-res server time, and a static counter,
		// both converted to alphanumeric lower-case (base-36), ends up being ~10 chars.
		// allows for *up to* 1,296 unique ids per millisecond (sort of).
		this._uniqueIDCounter++;
		if (this._uniqueIDCounter >= Math.pow(36, 2)) this._uniqueIDCounter = 0;
		
		return [
			prefix,
			Tools.zeroPad( (new Date()).getTime().toString(36), 8 ),
			Tools.zeroPad( this._uniqueIDCounter.toString(36), 2 )
		].join('');		
	},
	
	tick: function() {
		// maintain worker children, called every 1s
		for (var pool_key in this.worker_pools) {
			this.worker_pools[pool_key].tick();
		}
	},
	
	shutdown: function(callback) {
		// shut down all workers in all pools
		var self = this;
		var pool_keys = Object.keys(this.worker_pools);
		this.logDebug(3, "Worker Pool Manager shutting down");
		
		if (pool_keys.length) {
			async.each( pool_keys,
				function(pool_key, callback) {
					self.worker_pools[pool_key].shutdown( callback );
				},
				callback
			); // each
		}
		else callback();
	},
	
	emergencyShutdown: function(signal) {
		// kill all children as soon as possible (crash, etc.)
		if (!signal) signal = 'SIGTERM';
		this.logDebug(1, "Emergency shutdown, killing all children");
		
		for (var pool_key in this.worker_pools) {
			var pool = this.worker_pools[pool_key];
			var workers = pool.getWorkers();
			for (var pid in workers) {
				this.logDebug(2, "Killing " + pool_key + " PID " + pid + " with signal " + signal);
				process.kill( pid, signal );
			}
		}
	}
	
}); // class
