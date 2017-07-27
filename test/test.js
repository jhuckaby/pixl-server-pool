// Unit tests for pixl-server-pool
// Copyright (c) 2017 Joseph Huckaby
// Released under the MIT License

var os = require('os');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var http = require('http');
var async = require('async');

var Class = require("pixl-class");
var PixlServer = require('pixl-server');
var Tools = require("pixl-tools");
var PixlRequest = require('pixl-request');
var Perf = require('pixl-perf');

var request = new PixlRequest();
var agent = new http.Agent({ keepAlive: true });

process.chdir( __dirname );

// util.isArray is DEPRECATED??? Nooooooooode!
var isArray = Array.isArray || util.isArray;

var server = new PixlServer({
	
	__name: 'WebServerTest',
	__version: "1.0",
	
	config: {
		"log_dir": __dirname,
		"log_filename": "test.log",
		"debug_level": 9,
		"debug": 1,
		"echo": 0,
		
		"WebServer": {
			"http_port": 3020,
			"http_htdocs_dir": __dirname,
			"http_max_upload_size": 1024 * 10,
			"http_static_ttl": 3600,
			"http_static_index": "index.html",
			"http_server_signature": "WebServerTest 1.0",
			"http_gzip_text": 1,
			"http_timeout": 5,
			"http_response_headers": {
				"Via": "WebServerTest 1.0"
			},
			
			"http_log_requests": false,
			"http_regex_log": ".+",
			"http_recent_requests": 10,
			"http_max_connections": 100
		},
		
		"PoolManager": {
			"ticks": false,
			"pools": {
				"TestPool1": {
					"enabled": true,
					"script": "child.js",
					"uri_match": "^/pool1",
					min_children: 1,
					max_children: 1,
					max_concurrent_requests: 1,
					max_requests_per_child: 0
				}
			}
		},
	},
	
	components: [
		require('pixl-server-web'),
		require('pixl-server-pool')
	]
	
});

// Unit Tests

module.exports = {
	setUp: function (callback) {
		var self = this;
		this.server = server;
		
		server.on('prestart', function() {
			// write log in sync mode, for troubleshooting
			server.logger.set('sync', true);
		});
		
		// delete old unit test log
		fs.unlink( "test.log", function(err) {
			// test suite ready
			callback();
		} ); // delete
	},
	
	tests: [
		
		function testInitialStartup(test) {
			// make sure initial pool started up
			var self = this;
			
			this.server.on('shutdown', function() {
				test.fatal( "Premature shutdown!  See test.log for details." );
			});
			
			this.server.startup( function() {
				// startup complete
				self.server.removeAllListeners('shutdown');
				
				var web_server = self.web_server = server.WebServer;
				var wpm = self.wpm = server.PoolManager;
				
				var pool = wpm.getPool('TestPool1');
				test.ok( !!pool, "Got test pool" );
				
				var workers = pool.getWorkers();
				test.ok( !!workers, "Got workers hash" );
				test.ok( Tools.numKeys(workers) == 1, "Correct number of workers" );
				
				var pid = Tools.firstKey( workers );
				var worker = pool.getWorker( pid );
				test.ok( !!worker, "Got single worker" );
				test.ok( worker.getState() == 'active', "Correct state in worker: " + worker.getState() );
				
				test.ok( self.isProcessRunning(pid), "Worker process is alive and can be pinged" );
				
				test.done();
				
			} ); // startup
		},
		
		function testInternalRequest(test) {
			// test internal request to pool (not web)
			var self = this;
			var pool = this.wpm.getPool('TestPool1');
			
			var data = {
				test: 1234
			};
			
			pool.delegateCustom( data, function(err, resp, perf) {
				var metrics = perf.metrics();
				test.debug("Response:", resp);
				test.debug("Perf:", metrics);
				
				test.ok( !err, "No error from delegateCustom: " + err );
				test.ok( !!resp, "Got response object" );
				
				test.ok( resp.code == 0, "Correct code in response: " + resp.code );
				test.ok( !!resp.user, "Found user object in response" );
				test.ok( resp.user.Name == "Joe", "Correct user name in response: " + resp.user.Name );
				test.ok( !!resp.params, "Got params object in response" );
				test.ok( resp.params.test == 1234, "Correct data echoed back" );
				
				test.ok( !!resp.pid, "Got PID in response" );
				test.ok( !!pool.getWorker(resp.pid), "PID matches active worker" );
				
				test.ok( !!resp.hostname, "Got hostname in response" );
				test.ok( resp.hostname == server.hostname, "Correct hostname from worker: " + resp.hostname );
				
				test.done();
			} ); // delegateCustom
		},
		
		function testMockWebRequest(test) {
			// test simulated web pool request
			var pool = this.wpm.getPool('TestPool1');
			
			var args = {
				ip: '127.0.0.1',
				ips: ['127.0.0.1'],
				request: {
					method: 'GET',
					headers: { 'host': '127.0.0.1:3020' },
					url: '/pool1?type=json'
				},
				query: { 'type': 'json' },
				cookies: {},
				params: {}
			};
			
			pool.delegateRequest( args, function(status, headers, body) {
				test.debug("Status: " + status);
				test.debug("Headers:", headers);
				test.debug("Body: " + body);
				
				test.ok( status == "200 OK", "Correct HTTP status line: " + status );
				test.ok( !!headers, "Got headers" );
				test.ok( headers['Content-Type'] == "application/json", "Correct Content-Type: " + headers['Content-Type'] );
				test.ok( !!body, "Got body content" );
				
				var json = null;
				try { json = JSON.parse( body ); }
				catch (err) {
					test.ok( false, "Failed to parse JSON: " + err );
				}
				
				test.ok( !!json, "Got JSON in response" );
				test.ok( json.code == 0, "Correct code in JSON response: " + json.code );
				test.ok( !!json.user, "Found user object in JSON response" );
				test.ok( json.user.Name == "Joe", "Correct user name in JSON response: " + json.user.Name );
				
				test.ok( !!json.pid, "Got PID in response" );
				test.ok( !!pool.getWorker(json.pid), "PID matches active worker" );
				
				test.done();
			} );
		},
		
		function testSimpleExternalRequest(test) {
			// test real HTTP GET request to webserver backend
			var self = this;
			
			request.json( 'http://127.0.0.1:3020/pool1?type=json', false,
				{
					headers: {
						'X-Test': "Test"
					}
				},
				function(err, resp, json, perf) {
					test.ok( !err, "No error from PixlRequest: " + err );
					test.ok( !!resp, "Got resp from PixlRequest" );
					test.ok( resp.statusCode == 200, "Got 200 response: " + resp.statusCode );
					test.ok( resp.headers['via'] == "WebServerTest 1.0", "Correct Via header: " + resp.headers['via'] );
					test.ok( !!json, "Got JSON in response" );
					test.ok( json.code == 0, "Correct code in JSON response: " + json.code );
					test.ok( !!json.user, "Found user object in JSON response" );
					test.ok( json.user.Name == "Joe", "Correct user name in JSON response: " + json.user.Name );
					
					// request headers will be echoed back
					test.ok( !!json.headers, "Found headers echoed in JSON response" );
					test.ok( json.headers['x-test'] == "Test", "Found Test header echoed in JSON response" );
					
					var pool = self.wpm.getPool('TestPool1');
					test.ok( !!json.pid, "Got PID in response" );
					test.ok( !!pool.getWorker(json.pid), "PID matches active worker" );
					
					test.done();
				} 
			);
		},
		
		function testChildRouteExternalRequest(test) {
			// test real HTTP GET request to webserver backend, using child routed URI
			var self = this;
			
			request.json( 'http://127.0.0.1:3020/pool1/childroute', false,
				{
					headers: {
						'X-Test': "Test"
					}
				},
				function(err, resp, json, perf) {
					test.ok( !err, "No error from PixlRequest: " + err );
					test.ok( !!resp, "Got resp from PixlRequest" );
					test.ok( resp.statusCode == 200, "Got 200 response: " + resp.statusCode );
					test.ok( resp.headers['via'] == "WebServerTest 1.0", "Correct Via header: " + resp.headers['via'] );
					test.ok( !!json, "Got JSON in response" );
					test.ok( json.code == 0, "Correct code in JSON response: " + json.code );
					test.ok( json.routed == true, "Found 'routed' property, with correct value, in response JSON" );
					test.done();
				} 
			);
		},
		
		// http 429
		function testTooManyRequests(test) {
			// TestPool1 only allows 1 concurrent req, so let's go beyond it
			var self = this;
			
			async.parallel(
				[
					function(callback) {
						request.json( 'http://127.0.0.1:3020/pool1?type=json&sleep=500', false, {},
							function(err, resp, json, perf) {
								test.ok( !err, "No error from PixlRequest: " + err );
								test.ok( !!resp, "Got resp from PixlRequest" );
								test.ok( resp.statusCode == 200, "Got 200 response: " + resp.statusCode );
								callback();
							}
						); // request.json
					},
					function(callback) {
						// delay this one by 250ms
						setTimeout( function() {
							// other req should be in progress, this one should fail
							request.json( 'http://127.0.0.1:3020/pool1?type=json', false, {},
								function(err, resp, json, perf) {
									test.ok( !!err, "Error expected from PixlRequest" );
									test.ok( err.code == 429, "Correct HTTP error code: " + err.code );
									callback();
								}
							); // request.json
						}, 250 );
					}
				],
				function(err) {
					test.ok( !err, "No error from parallel functions: " + err );
					test.done();
				}
			); // parallel
		},
		
		// auto-scale up
		function testAutoScaleUp(test) {
			// test worker scaling
			var self = this;
			var pool = this.wpm.getPool('TestPool1');
			
			// hot-change config (FUTURE: Official API for this)
			pool.config.max_children = 2;
			pool.config.max_concurrent_requests = 2;
			
			// catch autoscale message
			var got_as_msg = false;
			pool.once('autoscale', function(message) {
				test.ok( message.cmd == 'add', "Correct autoscale message" );
				got_as_msg = true;
			});
			
			async.parallel(
				[
					function(callback) {
						request.json( 'http://127.0.0.1:3020/pool1?type=json&sleep=500', false, {},
							function(err, resp, json, perf) {
								test.ok( !err, "No error from PixlRequest: " + err );
								test.ok( !!resp, "Got resp from PixlRequest" );
								test.ok( resp.statusCode == 200, "Got 200 response: " + resp.statusCode );
								callback();
							}
						); // request.json
					},
					function(callback) {
						// delay this one by 250ms
						setTimeout( function() {
							// force a tick, which should fire off a new worker child
							pool.tick();
							
							var workers = pool.getWorkers();
							test.ok( !!workers, "Got workers hash" );
							test.ok( Tools.numKeys(workers) == 2, "Correct number of workers after autoscale event" );
							
							callback();
						}, 250 );
					}
				],
				function(err) {
					test.ok( !err, "No error from parallel functions: " + err );
					
					// wait for all children to become active
					async.whilst(
						function() {
							var states = pool.getStates();
							return (states.active != 2);
						},
						function(callback) {
							setTimeout( function() { callback(); }, 100 );
						},
						function(err) {
							test.ok( true, "All children are active" );
							test.ok( got_as_msg, "Received autoscale message" );
							test.done();
						}
					); // whilst
				}
			); // parallel
		},
		
		// auto-scale down
		function testAutoScaleDown(test) {
			// test worker scaling downward
			var self = this;
			var pool = this.wpm.getPool('TestPool1');
			
			// This test relies on the state leftover from the previous test
			// i.e. 2 children active but only 1 is actually needed
			// Reconfirm this state before proceeding
			var workers = pool.getWorkers();
			test.ok( !!workers, "Got workers hash" );
			test.ok( Tools.numKeys(workers) == 2, "Correct number of workers" );
			
			// both children should be active (idle)
			var states = pool.getStates();
			test.ok ( states.active == 2, "Correct number of workers active (idle)" );
			
			// sanity check: no reqs should be active at this time
			test.ok ( pool.num_active_requests == 0, "No requests are active" );
			
			// catch autoscale message
			var got_as_msg = false;
			pool.once('autoscale', function(message) {
				test.ok( message.cmd == 'remove', "Correct autoscale message" );
				got_as_msg = true;
			});
			
			// force tick which should autoscale down
			pool.tick();
			
			// wait for worker to shutdown
			async.whilst(
				function() {
					var workers = pool.getWorkers();
					return (Tools.numKeys(workers) != 1);
				},
				function(callback) {
					setTimeout( function() { callback(); }, 100 );
				},
				function(err) {
					test.ok( true, "Down to 1 worker again" );
					test.ok( got_as_msg, "Received autoscale message" );
					test.done();
				}
			); // whilst
		},
		
		// max_children: Make sure a 3rd child isn't spawned with 2 concurrent reqs
		function testAutoScaleMaxChildren(test) {
			// test max_children setting with auto-scale
			var self = this;
			var pool = this.wpm.getPool('TestPool1');
			
			// This test relies on the state leftover from the previous test
			// i.e. 1 child active but 2 max
			// Reconfirm this state before proceeding
			var workers = pool.getWorkers();
			test.ok( !!workers, "Got workers hash" );
			test.ok( Tools.numKeys(workers) == 1, "Correct number of workers" );
			
			// child should be active (idle)
			var states = pool.getStates();
			test.ok ( states.active == 1, "Correct number of workers active (idle)" );
			
			// sanity check: no reqs should be active at this time
			test.ok ( pool.num_active_requests == 0, "No requests are active" );
			
			// force a 2nd worker to spawn, to max us out
			pool.addWorker( function(err) {
				// worker should be ready now
				test.ok( !err, "No error spawning 2nd worker: " + err );
				
				var workers = pool.getWorkers();
				test.ok( !!workers, "Got workers hash" );
				test.ok( Tools.numKeys(workers) == 2, "Correct number of workers" );
				
				var states = pool.getStates();
				test.ok ( states.active == 2, "Correct number of workers active (idle)" );
				
				async.parallel(
					[
						function(callback) {
							request.json( 'http://127.0.0.1:3020/pool1?type=json&sleep=500&p=1', false, {},
								function(err, resp, json, perf) {
									test.ok( !err, "No error from PixlRequest: " + err );
									test.ok( !!resp, "Got resp from PixlRequest" );
									test.ok( resp.statusCode == 200, "Got 200 response: " + resp.statusCode );
									callback();
								}
							); // request.json
						},
						function(callback) {
							request.json( 'http://127.0.0.1:3020/pool1?type=json&sleep=500&p=2', false, {},
								function(err, resp, json, perf) {
									test.ok( !err, "No error from PixlRequest: " + err );
									test.ok( !!resp, "Got resp from PixlRequest" );
									test.ok( resp.statusCode == 200, "Got 200 response: " + resp.statusCode );
									callback();
								}
							); // request.json
						},
						function(callback) {
							// delay this one by 250ms
							setTimeout( function() {
								// force a tick, which should do nothing
								pool.tick();
								
								var workers = pool.getWorkers();
								test.ok( !!workers, "Got workers hash" );
								test.ok( Tools.numKeys(workers) == 2, "Correct number of workers after tick" );
								
								var states = pool.getStates();
								test.ok ( states.active == 2, "Correct number of workers active (idle)" );
								
								callback();
							}, 250 );
						}
					],
					function(err) {
						test.ok( !err, "No error from parallel functions: " + err );
						test.done();
						// Leaving 2 children active here
					}
				); // parallel
			} ); // addWorker
		},
		
		// auto-scale with headroom
		function testAutoScaleMaxHeadroom(test) {
			// auto-scale with child headroom
			var self = this;
			var pool = this.wpm.getPool('TestPool1');
			
			// This test relies on the state leftover from the previous test
			// i.e. 2 children active
			// Reconfirm this state before proceeding
			var workers = pool.getWorkers();
			test.ok( !!workers, "Got workers hash" );
			test.ok( Tools.numKeys(workers) == 2, "Correct number of workers" );
			
			// both children should be active (idle)
			var states = pool.getStates();
			test.ok ( states.active == 2, "Correct number of workers active (idle)" );
			
			// sanity check: no reqs should be active at this time
			test.ok ( pool.num_active_requests == 0, "No requests are active" );
			
			// hot-change config
			pool.config.child_headroom_pct = 100;
			pool.config.max_children = 3;
			pool.config.max_concurrent_launches = 2;
			
			// a tick with 0 reqs should kill a worker
			pool.tick();
			
			// wait for worker to shutdown
			async.whilst(
				function() {
					var workers = pool.getWorkers();
					return (Tools.numKeys(workers) != 1);
				},
				function(callback) {
					setTimeout( function() { callback(); }, 100 );
				},
				function(err) {
					test.ok( true, "Down to 1 worker again" );
					
					var states = pool.getStates();
					test.ok ( states.active == 1, "Correct number of workers active (idle)" );
					
					async.parallel(
						[
							function(callback) {
								request.json( 'http://127.0.0.1:3020/pool1?type=json&sleep=500', false, {},
									function(err, resp, json, perf) {
										test.ok( !err, "No error from PixlRequest: " + err );
										test.ok( !!resp, "Got resp from PixlRequest" );
										test.ok( resp.statusCode == 200, "Got 200 response: " + resp.statusCode );
										callback();
									}
								); // request.json
							},
							function(callback) {
								// delay this one by 250ms
								setTimeout( function() {
									// force a tick, which should fire off a new worker
									pool.tick();
									
									var workers = pool.getWorkers();
									test.ok( !!workers, "Got workers hash" );
									test.ok( Tools.numKeys(workers) == 2, "Correct number of workers after autoscale event" );
									
									// now force another tick, which should launch another worker
									pool.tick();
									
									var workers = pool.getWorkers();
									test.ok( !!workers, "Got workers hash" );
									test.ok( Tools.numKeys(workers) == 3, "Correct number of workers after autoscale event" );
									
									callback();
								}, 250 );
							}
						],
						function(err) {
							test.ok( !err, "No error from parallel functions: " + err );
							
							// wait for all children to become active
							async.whilst(
								function() {
									var states = pool.getStates();
									return (states.active != 3);
								},
								function(callback) {
									setTimeout( function() { callback(); }, 100 );
								},
								function(err) {
									test.ok( true, "All children are active" );
									test.done();
									// Leaving 3 children active here
								}
							); // whilst
						}
					); // parallel
				} // whilst callback
			); // whilst
		},
		
		// HTTP POST (Standard)
		function testStandardPost(test) {
			request.post( 'http://127.0.0.1:3020/pool1?type=json',
				{
					headers: {
						'X-Test': "Test"
					},
					data: {
						myparam: "foobar4567"
					}
				},
				function(err, resp, data, perf) {
					test.ok( !err, "No error from PixlRequest: " + err );
					test.ok( !!resp, "Got resp from PixlRequest" );
					test.ok( resp.statusCode == 200, "Got 200 response: " + resp.statusCode );
					test.ok( resp.headers['via'] == "WebServerTest 1.0", "Correct Via header: " + resp.headers['via'] );
					
					// parse json in response
					var json = null;
					try { json = JSON.parse( data.toString() ); }
					catch (err) {
						test.ok( false, "Error parsing JSON: " + err );
						test.done();
					}
					
					test.ok( !!json, "Got JSON in response" );
					test.ok( json.code == 0, "Correct code in JSON response: " + json.code );
					test.ok( !!json.params, "Found params object in JSON response" );
					test.ok( json.params.myparam == "foobar4567", "Correct param in JSON response: " + json.params.myparam );
					
					// request headers will be echoed back
					test.ok( !!json.headers, "Found headers echoed in JSON response" );
					test.ok( json.headers['x-test'] == "Test", "Found Test header echoed in JSON response" );
					
					test.done();
				} 
			);
		},
		
		// HTTP POST + File Upload
		function testMultipartPost(test) {
			request.post( 'http://127.0.0.1:3020/pool1?type=json',
				{
					headers: {
						'X-Test': "Test"
					},
					multipart: true,
					data: {
						myparam: "foobar5678"
					},
					files: {
						file1: "spacer.gif"
					}
				},
				function(err, resp, data, perf) {
					test.ok( !err, "No error from PixlRequest: " + err );
					test.ok( !!resp, "Got resp from PixlRequest" );
					test.ok( resp.statusCode == 200, "Got 200 response: " + resp.statusCode );
					test.ok( resp.headers['via'] == "WebServerTest 1.0", "Correct Via header: " + resp.headers['via'] );
					
					// parse json in response
					var json = null;
					try { json = JSON.parse( data.toString() ); }
					catch (err) {
						test.ok( false, "Error parsing JSON: " + err );
						test.done();
					}
					
					// test.debug( "JSON Response: ", json );
					
					test.ok( !!json, "Got JSON in response" );
					test.ok( json.code == 0, "Correct code in JSON response: " + json.code );
					test.ok( !!json.params, "Found params object in JSON response" );
					test.ok( json.params.myparam == "foobar5678", "Correct param in JSON response: " + json.params.myparam );
					test.ok( !!json.headers, "Found headers echoed in JSON response" );
					test.ok( json.headers['x-test'] == "Test", "Found Test header echoed in JSON response" );
					test.ok( !!json.files, "Found files object in JSON response" );
					test.ok( !!json.files.file1, "Found file1 object in JSON response" );
					test.ok( json.files.file1.size == 43, "Uploaded file has correct size (43): " + json.files.file1.size );
					test.done();
				} 
			);
		},
		
		// Binary HTTP POST
		function testBinaryPost(test) {
			request.post( 'http://127.0.0.1:3020/pool1?type=json',
				{
					headers: {
						'Content-Type': "application/octet-stream",
						'X-Test': "Test"
					},
					data: fs.readFileSync('spacer.gif')
				},
				function(err, resp, data, perf) {
					test.ok( !err, "No error from PixlRequest: " + err );
					test.ok( !!resp, "Got resp from PixlRequest" );
					test.ok( resp.statusCode == 200, "Got 200 response: " + resp.statusCode );
					test.ok( resp.headers['via'] == "WebServerTest 1.0", "Correct Via header: " + resp.headers['via'] );
					
					// parse json in response
					var json = null;
					try { json = JSON.parse( data.toString() ); }
					catch (err) {
						test.ok( false, "Error parsing JSON: " + err );
						test.done();
					}
					
					test.ok( !!json, "Got JSON in response" );
					test.ok( json.code == 0, "Correct code in JSON response: " + json.code );
					test.ok( !!json.params, "Found params object in JSON response" );
					
					var buf = fs.readFileSync('spacer.gif');
					test.ok( json.params.len == buf.length, "Correct buf length JSON response: " + json.params.len );
					test.ok( json.params.digest == Tools.digestHex(buf), "Correct SHA256 digest of binary buffer: " + json.params.digest );
					
					// request headers will be echoed back
					test.ok( !!json.headers, "Found headers echoed in JSON response" );
					test.ok( json.headers['x-test'] == "Test", "Found Test header echoed in JSON response" );
					
					test.done();
				} 
			);
		},
		
		// JSON POST
		function testJSONPOST(test) {
			// test JSON HTTP POST request to webserver backend
			request.json( 'http://127.0.0.1:3020/pool1?type=json', { foo: 'barpost' },
				{
					headers: {
						'X-Test': "Test"
					}
				},
				function(err, resp, json, perf) {
					test.ok( !err, "No error from PixlRequest: " + err );
					test.ok( !!resp, "Got resp from PixlRequest" );
					test.ok( resp.statusCode == 200, "Got 200 response: " + resp.statusCode );
					test.ok( resp.headers['via'] == "WebServerTest 1.0", "Correct Via header: " + resp.headers['via'] );
					test.ok( !!json, "Got JSON in response" );
					test.debug( "JSON Response", json );
					test.ok( json.code == 0, "Correct code in JSON response: " + json.code );
					
					test.ok( !!json.params, "Found params object in JSON response" );
					test.ok( json.params.foo == "barpost", "Correct param in JSON response: " + json.params.foo );
					
					test.ok( !!json.headers, "Found headers echoed in JSON response" );
					test.ok( json.headers['x-test'] == "Test", "Found Test header echoed in JSON response" );
					
					test.done();
				} 
			);
		},
		
		// binary buffer response
		function testBinaryTypeResponse(test) {
			// test simple HTTP GET to webserver backend
			request.get( 'http://127.0.0.1:3020/pool1?type=buffer',
				function(err, resp, data, perf) {
					test.ok( !err, "No error from PixlRequest: " + err );
					test.ok( !!resp, "Got resp from PixlRequest" );
					test.ok( resp.statusCode == 200, "Got 200 response: " + resp.statusCode );
					test.ok( resp.headers['via'] == "WebServerTest 1.0", "Correct Via header: " + resp.headers['via'] );
					
					test.ok( !!resp.headers['content-type'], "Content-Type header present" );
					test.ok( !!resp.headers['content-type'].match(/image\/gif/), "Content-Type header contains correct value" );
					
					test.ok( !resp.headers['content-encoding'], "Content-Encoding header should NOT be present!" );
					
					test.ok( !!data, "Got data in response" );
					
					var buf = fs.readFileSync('spacer.gif');
					test.ok( data.length == buf.length, "Correct buf length response: " + data.length );
					test.ok( Tools.digestHex(data) == Tools.digestHex(buf), "Correct SHA256 digest of binary buffer" );
					
					test.done();
				} 
			);
		},
		
		// file response
		function testFileTypeResponse(test) {
			// test simple HTTP GET to webserver backend
			request.get( 'http://127.0.0.1:3020/pool1?type=file',
				function(err, resp, data, perf) {
					test.ok( !err, "No error from PixlRequest: " + err );
					test.ok( !!resp, "Got resp from PixlRequest" );
					test.ok( resp.statusCode == 200, "Got 200 response: " + resp.statusCode );
					test.ok( resp.headers['via'] == "WebServerTest 1.0", "Correct Via header: " + resp.headers['via'] );
					
					test.ok( !!resp.headers['content-type'], "Content-Type header present" );
					test.ok( !!resp.headers['content-type'].match(/image\/gif/), "Content-Type header contains correct value" );
					
					test.ok( !resp.headers['content-encoding'], "Content-Encoding header should NOT be present!" );
					
					test.ok( !!data, "Got data in response" );
					
					var buf = fs.readFileSync('spacer.gif');
					test.ok( data.length == buf.length, "Correct buf length response: " + data.length );
					test.ok( Tools.digestHex(data) == Tools.digestHex(buf), "Correct SHA256 digest of binary buffer" );
					
					test.done();
				} 
			);
		},
		
		// string type
		function testStringTypeResponse(test) {
			// test simple HTTP GET to webserver backend
			request.get( 'http://127.0.0.1:3020/pool1?type=string',
				function(err, resp, data, perf) {
					test.ok( !err, "No error from PixlRequest: " + err );
					test.ok( !!resp, "Got resp from PixlRequest" );
					test.ok( resp.statusCode == 200, "Got 200 response: " + resp.statusCode );
					test.ok( resp.headers['via'] == "WebServerTest 1.0", "Correct Via header: " + resp.headers['via'] );
					
					test.ok( !!resp.headers['content-type'], "Content-Type header present" );
					test.ok( !!resp.headers['content-type'].match(/text\/html/), "Content-Type header contains correct value" );
					
					test.ok( !!resp.headers['content-encoding'], "Content-Encoding header present" );
					test.ok( !!resp.headers['content-encoding'].match(/gzip/), "Content-Encoding header contains gzip" );
					
					test.ok( !!data, "Got HTML in response" );
					test.ok( data.toString() === fs.readFileSync('index.html', 'utf8'), "index.html content is correct" );
					
					test.done();
				} 
			);
		},
		
		// child error
		function testChildError(test) {
			request.get( 'http://127.0.0.1:3020/pool1?type=error',
				function(err, resp, data, perf) {
					test.ok( !err, "No error from PixlRequest: " + err );
					test.ok( !!resp, "Got resp from PixlRequest" );
					test.ok( resp.statusCode == 500, "Got 500 response: " + resp.statusCode );
					test.done();
				} 
			);
		},
		
		// redirect
		function testRedirect(test) {
			request.get( 'http://127.0.0.1:3020/pool1?type=redirect',
				function(err, resp, data, perf) {
					test.ok( !err, "No error from PixlRequest: " + err );
					test.ok( !!resp, "Got resp from PixlRequest" );
					test.ok( resp.statusCode == 302, "Got 302 response: " + resp.statusCode );
					test.ok( !!resp.headers['location'], "Got Location header" );
					test.ok( !!resp.headers['location'].match(/redirected/), "Correct Location header");
					test.done();
				} 
			);
		},
		
		// send message
		function testMessage(test) {
			// test sending a message to all pool children
			var self = this;
			var pool = this.wpm.getPool('TestPool1');
			
			var workers = pool.getWorkers();
			test.ok( !!workers, "Got workers hash" );
			test.ok( Tools.numKeys(workers) == 3, "Correct number of workers" );
			
			// both children should be active (idle)
			var states = pool.getStates();
			test.ok ( states.active == 3, "Correct number of workers active (idle)" );
			
			// sanity check: no reqs should be active at this time
			test.ok ( pool.num_active_requests == 0, "No requests are active" );
			
			var received = {};
			
			pool.on('message', function(message) {
				test.debug("Got message reply: ", message);
				test.ok( !!message.pid, "Got PID in message" );
				test.ok( !!message.data, "Got data in message" );
				var data = message.data;
				
				test.ok( data.test == 2345, "Found key echoed back in message" );
				test.ok( !!data.ADDED_BY_CHILD, "Found key added by child to message" );
				
				received[ message.pid ] = data;
				if (Tools.numKeys(received) == states.active) {
					test.ok( true, "Got all messages" );
					pool.removeAllListeners('message');
					test.done();
				}
			});
			
			pool.sendMessage( { test: 2345 } );
		},
		
		// shut down pool
		function testOnDemandRemovePool(test) {
			var self = this;
			var pool = this.wpm.getPool('TestPool1');
			
			var workers = pool.getWorkers();
			test.ok( !!workers, "Got workers hash" );
			
			var pids = Object.keys(workers);
			
			this.wpm.removePool('TestPool1', function() {
				// make sure all children are dead
				pids.forEach( function(pid) {
					test.ok( !self.isProcessRunning(pid), "PID is dead: " + pid );
				} );
				
				test.ok( !self.wpm.getPool('TestPool1'), "Pool is really gone" );
				test.done();
			});
		},
		
		// on-demand add pool
		function testOnDemandCreatePool(test) {
			var self = this;
			
			var pool_config = {
				"script": "child.js",
				"uri_match": "^/pool2",
				min_children: 5,
				max_children: 5,
				max_concurrent_requests: 50,
				max_requests_per_child: 0,
				auto_maint: false,
				maint_method: 'requests',
				maint_requests: 10
			};
			
			this.wpm.createPool( 'TestPool2', pool_config, function(err) {
				test.ok( !err, "No error during pool startup: " + err );
				
				var pool = self.wpm.getPool('TestPool2');
				test.ok( !!pool, "Got test pool" );
				
				var workers = pool.getWorkers();
				test.ok( !!workers, "Got workers hash" );
				test.ok( Tools.numKeys(workers) == 5, "Correct number of workers" );
				
				for (var pid in workers) {
					var worker = workers[pid];
					test.ok( worker.getState() == 'active', "Correct state in worker: " + worker.getState() );
					test.ok( self.isProcessRunning(pid), "Worker process is alive and can be pinged" );
				}
				
				test.done();
			} ); // createPool
		},
		
		function testOnDemandPoolExternalRequest(test) {
			// make sure prev pool is 404ing, and new pool is working
			var self = this;
			
			request.get( 'http://127.0.0.1:3020/pool1?type=json',
				function(err, resp, data, perf) {
					test.ok( !err, "No error from PixlRequest: " + err );
					test.ok( !!resp, "Got resp from PixlRequest" );
					test.ok( resp.statusCode == 404, "Got 404 response: " + resp.statusCode );
					
					request.json( 'http://127.0.0.1:3020/pool2?type=json', false, {},
						function(err, resp, json, perf) {
							test.ok( !err, "No error from PixlRequest: " + err );
							test.ok( !!resp, "Got resp from PixlRequest" );
							test.ok( resp.statusCode == 200, "Got 200 response: " + resp.statusCode );
							test.ok( resp.headers['via'] == "WebServerTest 1.0", "Correct Via header: " + resp.headers['via'] );
							test.ok( !!json, "Got JSON in response" );
							test.ok( json.code == 0, "Correct code in JSON response: " + json.code );
							test.ok( !!json.user, "Found user object in JSON response" );
							test.ok( json.user.Name == "Joe", "Correct user name in JSON response: " + json.user.Name );
							test.done();
						} 
					);
				} 
			);
		},
		
		function testOnDemandInternalRequest(test) {
			// test internal request to pool2 (not web)
			var self = this;
			var pool = this.wpm.getPool('TestPool2');
			
			var data = {
				test: 1234
			};
			
			pool.delegateCustom( data, function(err, resp, perf) {
				var metrics = perf.metrics();
				test.debug("Response:", resp);
				test.debug("Perf:", metrics);
				
				test.ok( !err, "No error from delegateCustom: " + err );
				test.ok( !!resp, "Got response object" );
				
				test.ok( resp.code == 0, "Correct code in response: " + resp.code );
				test.ok( !!resp.user, "Found user object in response" );
				test.ok( resp.user.Name == "Joe", "Correct user name in response: " + resp.user.Name );
				test.ok( !!resp.params, "Got params object in response" );
				test.ok( resp.params.test == 1234, "Correct data echoed back" );
				
				test.ok( !!resp.pid, "Got PID in response" );
				test.ok( !!pool.getWorker(resp.pid), "PID matches active worker" );
				
				test.done();
			} ); // delegateCustom
		},
		
		// maint
		function testRollingMaint(test) {
			// test maint request
			var self = this;
			var pool = this.wpm.getPool('TestPool2');
			
			var workers = pool.getWorkers();
			test.ok( !!workers, "Got workers hash" );
			test.ok( Tools.numKeys(workers) == 5, "Correct number of workers" );
			
			// all children should be active (idle)
			var states = pool.getStates();
			test.ok ( states.active == 5, "Correct number of workers active (idle)" );
			
			// sanity check: no reqs should be active at this time
			test.ok ( pool.num_active_requests == 0, "No requests are active" );
			
			var received = {};
			
			pool.on('message', function(message) {
				test.debug("Got message reply: ", message);
				test.ok( !!message.pid, "Got PID in message" );
				test.ok( !!message.data, "Got data in message" );
				var data = message.data;
				
				test.ok( data.CUSTOM_DATA == 1234, "Found key added by maint request" );
				test.ok( !!data.MAINT_COMPLETE, "Found key added by child to message" );
				
				received[ message.pid ] = data;
				
				// pool.logDebug(9, "GOT CUSTOM MAINT MESSAGE FROM "+message.pid+" ("+Tools.numKeys(received)+" children reported in)", message);
			});
			
			// request maint roll with custom data
			pool.requestMaint({ CUSTOM_DATA: 1234 });
			
			// tick should send first child into maint right away
			pool.tick();
			
			// wait for all workers to finish maint
			// note that it is entirely possible to catch the states so that all 5 are active 
			// (i.e. between one maint finish and the next started)
			// so we have to test on both states and # of messages received
			async.whilst(
				function() {
					var states = pool.getStates();
					// pool.logDebug(9, "IN WHILST LOOP, " + Tools.numKeys(received) + " children reported in", states);
					// return (states.active != 5);
					return( (states.active != 5) || (Tools.numKeys(received) != 5) );
				},
				function(callback) {
					setTimeout( function() { 
						// must keep ticking here
						pool.tick();
						callback(); 
					}, 100 );
				},
				function(err) {
					test.ok( true, "Maint complete on all children" );
					pool.removeAllListeners('message');
					test.done();
				}
			); // whilst
		},
		
		// restart
		function testRollingRestart(test) {
			// test restart request
			var self = this;
			var pool = this.wpm.getPool('TestPool2');
			
			var workers = pool.getWorkers();
			var old_pids = Object.keys(workers);
			
			test.ok( !!workers, "Got workers hash" );
			test.ok( Tools.numKeys(workers) == 5, "Correct number of workers" );
			
			// all children should be active (idle)
			var states = pool.getStates();
			test.ok ( states.active == 5, "Correct number of workers active (idle)" );
			
			// sanity check: no reqs should be active at this time
			test.ok ( pool.num_active_requests == 0, "No requests are active" );
			
			// test.debug("max_concurrent_launches = " + pool.config.max_concurrent_launches);
			
			// request maint roll with custom data
			pool.requestRestart();
			
			// tick should send first child into shutdown right away
			pool.tick();
			
			// wait for all workers to finish restart
			async.whilst(
				function() {
					var states = pool.getStates();
					var workers = pool.getWorkers();
					return( (states.active != 5) || (self.numKeysExist(old_pids, workers) > 0) );
				},
				function(callback) {
					setTimeout( function() { 
						// must keep ticking here
						pool.tick();
						callback(); 
					}, 100 );
				},
				function(err) {
					test.ok( true, "Restart complete on all children" );
					
					// make sure old pids are dead
					old_pids.forEach( function(pid) {
						test.ok( !self.isProcessRunning(pid), "Old PID is dead: " + pid );
					} );
					
					// make sure new worker pids are alive
					var workers = pool.getWorkers();
					var pids = Object.keys(workers);
					
					pids.forEach( function(pid) {
						test.ok( self.isProcessRunning(pid), "New PID is alive: " + pid );
					} );
					
					test.done();
				}
			); // whilst
		},
		
		// 50 parallel requests, 5 children, make sure all 5 have 5, should be even distribution
		function testParallelDistribution(test) {
			var self = this;
			var pool = this.wpm.getPool('TestPool2');
			
			async.parallel(
				[
					function(callback) {
						async.times( 50, 
							function(idx, callback) {
								request.json( 'http://127.0.0.1:3020/pool2?type=json&sleep=500', false, {},
									function(err, resp, json, perf) {
										// test.debug("Request #" + idx);
										test.ok( !err, "No error from PixlRequest: " + err );
										test.ok( !!resp, "Got resp from PixlRequest" );
										test.ok( resp.statusCode == 200, "Got 200 response: " + resp.statusCode );
										test.ok( resp.headers['via'] == "WebServerTest 1.0", "Correct Via header: " + resp.headers['via'] );
										test.ok( !!json, "Got JSON in response" );
										test.ok( json.code == 0, "Correct code in JSON response: " + json.code );
										test.ok( !!json.user, "Found user object in JSON response" );
										test.ok( json.user.Name == "Joe", "Correct user name in JSON response: " + json.user.Name );
										callback();
									} 
								);
							},
							callback
						); // times
					},
					function(callback) {
						// wait 250ms for this
						setTimeout( function() {
							// now all 50 should be in progress
							var workers = pool.getWorkers();
							
							test.ok( !!workers, "Got workers hash" );
							test.ok( Tools.numKeys(workers) == 5, "Correct number of workers" );
							
							// all children should be active (idle)
							var states = pool.getStates();
							test.ok ( states.active == 5, "Correct number of workers active (idle)" );
							
							// all reqs should be active at this time
							test.ok ( pool.num_active_requests == 50, "50 requests are active" );
							
							for (var pid in workers) {
								var worker = workers[pid];
								test.ok( worker.num_active_requests == 10, "Correct number of requests in worker" );
							}
							
							callback();
						}, 250 );
					}
				],
				function(err) {
					// parallel complete
					test.ok( !err, "No error from parallel functions: " + err );
					
					var workers = pool.getWorkers();
					
					test.ok( !!workers, "Got workers hash" );
					test.ok( Tools.numKeys(workers) == 5, "Correct number of workers" );
					
					// all children should be active (idle)
					var states = pool.getStates();
					test.ok ( states.active == 5, "Correct number of workers active (idle)" );
					
					// no reqs should be active at this time
					test.ok ( pool.num_active_requests == 0, "No requests are active" );
					
					test.done();
				}
			); // parallel
		},
		
		function testAutoMaint(test) {
			// test maint request
			var self = this;
			var pool = this.wpm.getPool('TestPool2');
			
			var workers = pool.getWorkers();
			test.ok( !!workers, "Got workers hash" );
			test.ok( Tools.numKeys(workers) == 5, "Correct number of workers" );
			
			// all children should be active (idle)
			var states = pool.getStates();
			test.ok ( states.active == 5, "Correct number of workers active (idle)" );
			
			// sanity check: no reqs should be active at this time
			test.ok ( pool.num_active_requests == 0, "No requests are active" );
			
			for (var pid in workers) {
				var worker = workers[pid];
				test.ok( worker.num_requests_served == 10, "Correct num_requests_served in worker" );
				test.ok( worker.last_maint == 0, "Correct last_maint in worker before auto_maint" );
			}
			
			var received = {};
			
			pool.on('message', function(message) {
				test.debug("Got message reply: ", message);
				test.ok( !!message.pid, "Got PID in message" );
				test.ok( !!message.data, "Got data in message" );
				var data = message.data;
				
				test.ok( !!data.MAINT_COMPLETE, "Found key added by child to message" );
				
				received[ message.pid ] = data;
			});
			
			// enable auto_maint
			pool.config.auto_maint = true;
			pool.config.maint_method = 'requests';
			pool.config.maint_requests = 10;
			
			// tick should send first child into maint right away
			pool.tick();
			
			// wait for all workers to finish maint
			// note that it is entirely possible to catch the states so that all 5 are active 
			// (i.e. between one maint finish and the next started)
			// so we have to test on both states and # of messages received
			async.whilst(
				function() {
					var states = pool.getStates();
					return( (states.active != 5) || (Tools.numKeys(received) != 5) );
				},
				function(callback) {
					setTimeout( function() { 
						// must keep ticking here
						pool.tick();
						callback(); 
					}, 100 );
				},
				function(err) {
					test.ok( true, "Maint complete on all children" );
					pool.removeAllListeners('message');
					test.done();
				}
			); // whilst
		},
		
		// max_requests_per_child
		function testMaxRequestsPerChild(test) {
			var self = this;
			var pool = this.wpm.getPool('TestPool2');
			
			var workers = pool.getWorkers();
			var old_pids = Object.keys(workers);
			
			test.ok( !!workers, "Got workers hash" );
			test.ok( Tools.numKeys(workers) == 5, "Correct number of workers" );
			
			// all children should be active (idle)
			var states = pool.getStates();
			test.ok ( states.active == 5, "Correct number of workers active (idle)" );
			
			// sanity check: no reqs should be active at this time
			test.ok ( pool.num_active_requests == 0, "No requests are active" );
			
			// make sure num_requests_served is what we expect at this point
			for (var pid in workers) {
				var worker = workers[pid];
				test.ok( worker.num_requests_served == 10, "Correct num_requests_served in worker" );
			}
			
			// force max_requests_per_child update (MUST COPY TO ALL WORKERS)
			// (it's cached in each worker because of the support for random ranges)
			pool.config.max_requests_per_child = 10;
			for (var pid in workers) {
				var worker = workers[pid];
				worker.max_requests_per_child = pool.config.max_requests_per_child;
			}
			
			// tick should send first child into shutdown right away
			pool.tick();
			
			// wait for all workers to finish restart
			async.whilst(
				function() {
					var states = pool.getStates();
					var workers = pool.getWorkers();
					return( (states.active != 5) || (self.numKeysExist(old_pids, workers) > 0) );
				},
				function(callback) {
					setTimeout( function() { 
						// must keep ticking here
						pool.tick();
						callback(); 
					}, 100 );
				},
				function(err) {
					test.ok( true, "Restart complete on all workers" );
					
					// make sure old pids are dead
					old_pids.forEach( function(pid) {
						test.ok( !self.isProcessRunning(pid), "Old PID is dead: " + pid );
					} );
					
					// make sure new worker pids are alive
					var workers = pool.getWorkers();
					var pids = Object.keys(workers);
					
					pids.forEach( function(pid) {
						test.ok( self.isProcessRunning(pid), "New PID is alive: " + pid );
					} );
					
					test.done();
				}
			); // whilst
		}
		
	], // tests
	
	numKeysExist: function(a, b) {
		// count how many 'a' hash keys exist in 'b', return count
		// if either a or b are arrays, convert to hashes
		if (isArray(a)) {
			var ah = {};
			a.forEach( function(v) { ah[v] = 1; } );
			a = ah;
		}
		if (isArray(b)) {
			var bh = {};
			b.forEach( function(v) { bh[v] = 1; } );
			b = bh;
		}
		
		var count = 0;
		for (var key in a) {
			if (key in b) count++;
		}
		return count;
	},
	
	isProcessRunning: function(pid) {
		// utility method, ping pid and return true/false
		try {
			process.kill( pid, 0 );
			return true;
		}
		catch (err) {
			return false;
		}
	},
	
	tearDown: function (callback) {
		// clean up
		var self = this;
		
		this.server.shutdown( function() {
			callback();
		} );
	}
	
};
