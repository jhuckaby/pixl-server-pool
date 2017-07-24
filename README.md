# Overview

This module is a component for use in [pixl-server](https://www.npmjs.com/package/pixl-server).  It manages pools of child worker processes, and is designed to integrate with the [pixl-server-web](https://www.npmjs.com/package/pixl-server-web) component (but can also run independently).  Using this you can delegate requests to pools of children, instead of processing everything in the parent process.  This can be very useful for CPU-hard operations such as image transformations.

Worker pools can have a fixed number of workers, or grow/shrink automatically based on usage and adjustable headroom.  Your worker code can listen for all child life cycle events, including startup, new request (obviously), custom message, maintenance, and shutdown.  You choose which requests are delegated to worker pools, either by URI pattern (routing), or by custom API calls from your code.

## Features

- Manage multiple simultaneous worker pools with separate configurations.
- Auto-scaling based on busy/idle workers.
- Configurable headroom adjustment for auto-scale events.
- Child life cycle management, max requests per child, etc.
- Custom rolling maintenance sweeps, for things like zero-downtime garbage collection.
- Automatic maintenance sweeps based on time or number of requests, or on-demand.
- Rolling worker restart requests with configurable concurrency.
- Automatic URI routing to worker pools and/or controlled delegation in code.
- Custom child worker requests (i.e. non-web-related).
- Custom messages sent to/from workers.

## Table of Contents

- [Overview](#overview)
	* [Features](#features)
- [Usage](#usage)
	* [Configuration](#configuration)
	* [Delegating Requests](#delegating-requests)
		+ [Automatic URI-Based Routing](#automatic-uri-based-routing)
		+ [Manual Request Routing](#manual-request-routing)
		+ [Worker Selection Algorithm](#worker-selection-algorithm)
	* [Writing Workers](#writing-workers)
		+ [Startup and Shutdown](#startup-and-shutdown)
		+ [Handling Requests](#handling-requests)
			- [args](#args)
			- [Text Responses](#text-responses)
			- [Binary Responses](#binary-responses)
			- [JSON Responses](#json-responses)
			- [File Responses](#file-responses)
			- [Error Responses](#error-responses)
			- [Performance Tracking](#performance-tracking)
			- [Custom Worker URI Routing](#custom-worker-uri-routing)
	* [Auto-Scaling](#auto-scaling)
		+ [Child Headroom](#child-headroom)
		+ [Max Concurrent Requests](#max-concurrent-requests)
		+ [Max Requests Per Child](#max-requests-per-child)
	* [Rolling Maintenance Sweeps](#rolling-maintenance-sweeps)
		+ [Automatic Routine Maintenance](#automatic-routine-maintenance)
	* [Rolling Restarts](#rolling-restarts)
	* [Sending Custom Requests](#sending-custom-requests)
		+ [Custom Request Args](#custom-request-args)
		+ [Custom Request Errors](#custom-request-errors)
	* [Sending Custom Pool Messages](#sending-custom-pool-messages)
		+ [Custom Worker-Sent Messages](#custom-worker-sent-messages)
	* [Events](#events)
		+ [message](#message)
		+ [autoscale](#autoscale)
		+ [maint](#maint)
		+ [restart](#restart)
	* [API](#api)
		+ [PoolManager](#poolmanager)
			- [PoolManager.getPool](#poolmanagergetpool)
		+ [WorkerPool](#workerpool)
			- [WorkerPool.delegateRequest](#workerpooldelegaterequest)
			- [WorkerPool.delegateCustom](#workerpooldelegatecustom)
			- [WorkerPool.sendMessage](#workerpoolsendmessage)
			- [WorkerPool.requestMaint](#workerpoolrequestmaint)
			- [WorkerPool.requestRestart](#workerpoolrequestrestart)
			- [WorkerPool.getWorkers](#workerpoolgetworkers)
			- [WorkerPool.getWorker](#workerpoolgetworker)
			- [WorkerPool.on](#workerpoolon)
		+ [WorkerProxy](#workerproxy)
			- [WorkerProxy.delegateRequest](#workerproxydelegaterequest)
			- [WorkerProxy.delegateCustom](#workerproxydelegatecustom)
			- [WorkerProxy.sendMessage](#workerproxysendmessage)
			- [WorkerProxy.shutdown](#workerproxyshutdown)
		+ [Worker](#worker)
			- [Worker.config](#workerconfig)
			- [Worker.addURIHandler](#workeraddurihandler)
			- [Worker.sendMessage](#workersendmessage)
	* [Client Errors](#client-errors)
		+ [HTTP 403 Forbidden](#http-403-forbidden)
		+ [HTTP 429 Too Many Requests](#http-429-too-many-requests)
		+ [HTTP 500 Internal Server Error](#http-500-internal-server-error)
		+ [HTTP 503 Service Unavailable](#http-503-service-unavailable)
		+ [HTTP 504 Gateway Timeout](#http-504-gateway-timeout)
	* [Logging](#logging)
- [License](#license)

# Usage

Use [npm](https://www.npmjs.com/) to install the module:

```
npm install pixl-server pixl-server-web pixl-server-pool
```

Here is a simple usage example.  Note that the component's official name is `PoolManager`, so that is what you should use for the configuration key, and for gaining access to the component via your server object.

```javascript
	var PixlServer = require('pixl-server');
	var server = new PixlServer({
		
		__name: 'MyServer',
		__version: "1.0",
		
		config: {
			"log_dir": "/var/log",
			"debug_level": 9,
			
			"WebServer": {
				"http_port": 80,
				"http_htdocs_dir": "/var/www/html"
			},
			
			"PoolManager": {
				"pools": {
					"MyTestPool": {
						"script": "my_worker.js",
						"uri_match": "^/pool",
						"min_children": 1,
						"max_children": 10
					}
				}
			}
		},
		
		components: [
			require('pixl-server-web'),
			require('pixl-server-pool')
		]
		
	});
	
	server.startup( function() {
		// server startup complete
	} );
```

Notice how we are loading the [pixl-server](https://www.npmjs.com/package/pixl-server) parent module, and then specifying [pixl-server-web](https://www.npmjs.com/package/pixl-server-web) and [pixl-server-pool](https://www.npmjs.com/package/pixl-server-pool) as components:

```javascript
	components: [
		require('pixl-server-web'),
		require('pixl-server-pool')
	]
```

This example demonstrates a very simple pool setup, which will automatically route incoming URIs starting with `/pool`, delegating those requests to worker children (up to 10 of them), and proxying their responses back to the client.  The workers themselves are spawned as child processes, where your script (specified by the `script` property) is pre-loaded to handle requests.  Example worker script:

```js
// my_worker.js
module.exports = {
	handler: function(args, callback) {
		// handle request in child and fire callback
		callback( 
			"200 OK", 
			{ 'Content-Type': "text/html" }, 
			"Hello this is <b>custom</b> HTML content!\n" 
		);
	}
};
```

There is quite a bit more you can do in the worker script, including custom URI routing, startup and shutdown handlers, maintenance routine, receiving and sending custom messages, performance tracking, and more.  See [Writing Workers](#writing-workers) below for details on all this.

The automatic URI routing via the `uri_match` property is entirely optional.  You can also handle requests in the parent process like a normal single-process app, and then delegate certain requests to your pools at your discretion.  You can even intercept and filter the worker responses.  See [Manual Request Routing](#manual-request-routing) for more.

## Configuration

The configuration for this component is specified by passing in a `PoolManager` key in the `config` element when constructing the `PixlServer` object, or, if a JSON configuration file is used, a `PoolManager` object at the outermost level of the file structure.  The `PoolManager` object accepts these properties:

| Property Name | Default Value | Description |
|---------------|---------------|-------------|
| `pools` | `{}` | Define worker pools to launch on startup (see below). |
| `startup_threads` | `1` | How many concurrent threads to use when launching multiple startup pools. |

Inside the `pools` object you can define one or more worker pools, which will all be launched on startup.  Each pool should be assigned a unique ID (property name, used for logging), and the value should be a sub-object with configuration parameters for the pool.  Example:

```js
"PoolManager": {
	"pools": {
		"MyTestPool1": {
			"script": "my_worker.js",
			"uri_match": "^/pool1",
			"min_children": 1,
			"max_children": 10
		},
		"MyTestPool2": {
			"script": "my_other_worker.js",
			"min_children": 5,
			"max_children": 5
		}
	}
}
```

This example would launch two separate worker pools at startup.  The first pool, `MyTestPool1`, would route all `^/pool1` URIs, with requests handled by a `my_worker.js` script (see [Writing Workers](#writing-workers) below), and would launch 1 worker and auto-scale up to 10 as needed.  The second pool, `MyTestPool2`, performs no URI routing at all (it needs requests explicitly sent in via code, see [Manual Request Routing](#manual-request-routing)), with requests handled by a `my_other_worker.js` script, and would launch exactly 5 workers and never scale up or down.

Here is the complete list of available properties for your pool definitions:

| Property Name | Default Value | Description |
|---------------|---------------|-------------|
| `enabled` | `true` | Enable or disable the pool (defaults to enabled). |
| `script` | `''` | Path to your worker script (see [Writing Workers](#writing-workers)). |
| `min_children` | `1` | Minimum number of workers to allow (see [Auto-Scaling](#auto-scaling). |
| `max_children` | `1` | Maximum number of workers to allow (see [Auto-Scaling](#auto-scaling). |
| `max_concurrent_requests` | `0` | Maximum number of concurrent requests to allow (total across all workers, see [Max Concurrent Requests](#max-concurrent-requests)). |
| `max_requests_per_child` | `0` | Maximum number of requests a worker can serve before it is cycled out (see [Max Requests Per Child](#max-requests-per-child)). |
| `max_concurrent_launches` | `1` | Maximum number of concurrent children to launch (for both startup and auto-scaling). |
| `max_concurrent_maint` | `1` | Maximum number of concurrent children to allow in a maintenance state (see [Rolling Maintenance Sweeps](#rolling-maintenance-sweeps)). |
| `child_headroom_pct` | `0` | Percentage of workers to over-allocate, for scaling purposes (see [Child Headroom](#child-headroom). |
| `child_busy_factor` | `1` | Number of concurrent requests served by one child to consider it to be "busy" (see [Auto-Scaling](#auto-scaling). |
| `startup_timeout_sec` | `0` | Maximum time allowed for workers to start up.  If exceeded the process is killed and an error logged. |
| `shutdown_timeout_sec` | `10` | Maximum time allowed for workers to shut down.  If exceeded a SIGKILL is sent and an error logged. |
| `request_timeout_sec` | `0` | Maximum execution time allowed per worker request.  If exceeded a [HTTP 504](#http-504-gateway-timeout) is sent. |
| `maint_timeout_sec` | `0` | Maximum time allowed per workers to complete maintenance.  If exceeded the worker is shut down and an error logged. |
| `auto_maint` | `false` | Set to `true` to automatically perform maintenance sweeps every N requests or N seconds (see [Rolling Maintenance Sweeps](#rolling-maintenance-sweeps)). |
| `maint_method` | `'requests'` | When `auto_maint` is enabled this prop can be set to either `'requests'` or `'time'` (strings). |
| `maint_requests` | `1000` | When `maint_method` is set to `requests` this specifies the number of worker requests to count between maintenance sweeps. |
| `maint_time_sec` | `0` | When `maint_method` is set to `time` this specifies the number of seconds between maintenance sweeps (tracked per worker). |
| `uri_match` | `''` | Optionally route all incoming web requests matching URI to worker pool (see [Delegating Requests](#delegating-requests)). |
| `acl` | `false` | Used in conjunction with `uri_match`, optionally enable [ACL restrictions](https://npmjs.com/package/pixl-server-web#access-control-lists) for routed requests. |

## Delegating Requests

For delegating web requests to worker pools, you have two options.  You can either use automatic routing based on URI patterns, or manually delegate requests yourself.  Both methods are discussed below.

### Automatic URI-Based Routing

For automatic routing based on the URI, all you need to do is specify a `uri_match` property in your pool configuration, and set the value to a regular expression (or a string, which will be interpreted as a regular expression) to match against incoming requests.  Example:

```js
"PoolManager": {
	"pools": {
		"MyTestPool1": {
			"uri_match": "^/pool1",
			"script": "my_worker.js"
		}
	}
}
```

This would route all requests with URIs that start with `/pool1` to the worker pool.  If you want to route *all* requests, just set the `uri_match` property to `".+"` (match anything).

If you need to apply [ACL restrictions](https://npmjs.com/package/pixl-server-web#access-control-lists) to your worker requests, set the `acl` property to `true` (or an array of [CIDR blocks](https://en.wikipedia.org/wiki/Classless_Inter-Domain_Routing)).  Example:

```js
"PoolManager": {
	"pools": {
		"MyTestPool1": {
			"uri_match": "^/pool1",
			"acl": ['127.0.0.1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
			"script": "my_worker.js"
		}
	}
}
```

### Manual Request Routing

For more control over your request workflow, you can choose exactly how and when to delegate requests to worker pools.  To do this, add a standard URI or method handler via [pixl-server-web](https://npmjs.com/package/pixl-server-web#custom-uri-handlers), which will initially run in the parent process.  Then, you can choose to delegate the request over to a worker pool, or not.

This code snippet assumes you have a preconfigured worker pool named `MyTestPool1`, and your [pixl-server](https://npmjs.com/package/pixl-server) instance is in scope and named `server`.

```js
server.startup( function() {
	// server startup complete, get a ref to our worker pool
	var pool = server.PoolManager.getPool('MyTestPool1');
	
	// add handler for our URI (runs in main process)
	server.WebServer.addURIHandler( /^\/pool1/, 'Pool Or Not', function(args, callback) {
		// custom request handler for our URI
		// choose whether to delegate to worker pool, or not
		if (Math.random() < 0.5) {
			// delegate request to worker pool (handles response as well)
			pool.delegateRequest( args, callback );
		}
		else {
			// handle request in main process
			callback( 
				"200 OK", 
				{ 'Content-Type': "text/html" }, 
				"Hello this is custom content!\n" 
			);
		}
	} );
} );
```

This is just a silly example that uses `Math.random()` to randomly delegate about half of all `/pool1` requests to the `MyTestPool1` worker pool, and serves the other half normally in the main (parent) process.  This demonstrates the [PoolManager.getPool()](#poolmanagergetpool) and [WorkerPool.delegateRequest()](#workerpooldelegaterequest) APIs.

If you want to include custom data along with the request to your worker, you can put it into `args.params`.  This object is serialized to JSON and passed directly to the worker script, and it can be used however you like.  Note that it may already contain data, as it contains HTTP POST params, among other things (see [args.params](https://www.npmjs.com/package/pixl-server-web#argsparams)).

If you want to intercept the *response* coming back from the worker, you can do that as well.  Instead of passing along the web callback to `delegateRequest()`, you can provide your own.  Your callback will receive the standard 3 arguments from [pixl-server-web](https://npmjs.com/package/pixl-server-web#custom-uri-handlers) URI handlers (i.e. HTTP status, headers, and body).  You can manipulate these, perform additional work, and finally execute the original callback to send the response to the client.  Example:

```js
server.startup( function() {
	// server startup complete, get a ref to our worker pool
	var pool = server.PoolManager.getPool('MyTestPool1');
	
	// add handler for our URI (runs in main process)
	server.WebServer.addURIHandler( /^\/pool1/, 'My Pool', function(args, callback) {
		// custom request handler for our URI
		// delegate request to worker pool and intercept response
		pool.delegateRequest( args, function(status, headers, body) {
			// got response back from worker, let's add a header
			headers['X-Custom'] = "Added in parent process after worker completed!";
			
			// fire original web callback
			callback( status, headers, body );
		} );
	} );
} );
```

### Worker Selection Algorithm

If multiple workers are active in your pool, the system picks an appropriate one for each request using an algorithm.  The selection process is made up of two phases:

- Gather all children serving the least amount of concurrent requests.
- Pick a random child from that sub-group.

So for example, if all your children are idle, it simply picks one at random.  But if some of them are serving requests, it will only pick from the least busiest group.  In this way you get a nice random spread of workers chosen, but they also tend to fill up equally.  You'll never have a situation where one worker is serving 10 requests while another is idle.

## Writing Workers

When a request is delegated to a worker, it runs in a child process.  The child communicates with the parent process via JSON on STDIN / STDOUT pipes, but all this is abstracted away from your code.  All you need to do is specify the path to your Node.js worker script via the `script` pool configuration property, and then export some key functions:

```js
// my_worker.js

module.exports = {
	startup: function(worker, callback) {
		// child is starting up
		this.worker = worker;
		callback();
	},
	
	handler: function(args, callback) {
		// handle request in child and fire callback
		callback( 
			"200 OK", 
			{ 'Content-Type': "text/html" }, 
			"Hello this is <b>custom</b> HTML content!\n" 
		);
	},
	
	shutdown: function(callback) {
		// child is shutting down
		callback();
	}
};
```

In this simple example we're exporting three functions, `startup()`, `handler()` and `shutdown()`.  All three are discussed below, but here is the full list of supported functions which have special meanings:

| Function Name | Required | Description |
|---------------|----------|-------------|
| `handler()` | **Yes** | Called once per request, with [args](#args) and a callback.  See [Handling Requests](#handling-requests) below. |
| `startup()` | No | Called once upon worker startup, and passed the [Worker](#worker) object.  See [Startup and Shutdown](#startup-and-shutdown) below. |
| `shutdown()` | No | Called once when worker is shutting down.  See [Startup and Shutdown](#startup-and-shutdown) below. |
| `custom()` | No | Called for each custom request, also with [args](#args) and a callback.  See [Sending Custom Requests](#sending-custom-requests) below. |
| `message()` | No | Called when worker receives a custom message.  See [Sending Custom Pool Messages](#sending-custom-pool-messages) below. |
| `maint()` | No | Called when worker needs to perform maintenance.  See [Rolling Maintenance Sweeps](#rolling-maintenance-sweeps) below. |

You can of course add any of your own functions into `module.exports`, and they will be ignored.  The only special functions are listed above.

### Startup and Shutdown

You can optionally hook the startup and shutdown events in your worker, and run custom code.  Both functions are passed a callback, so you can even perform asynchronous operations.  Startup example:

```js
// in my_worker.js
exports.startup = function(worker, callback) {
	// child is starting up, save reference to worker
	this.worker = worker;
	callback();
};
```

In the case of startup, your code is also passed a [Worker](#worker) object.  This can be used for a number of things, including communication with the parent process ([Sending Custom Pool Messages](#sending-custom-pool-messages)), getting the current pool configuration ([Worker.config](#workerconfig)), and adding custom URI handlers in the worker itself ([Custom Worker URI Routing](#custom-worker-uri-routing)).

Here is a shutdown example:

```js
// in my_worker.js
exports.shutdown = function(callback) {
	// perform any necessary shutdown tasks here
	callback();
};
```

### Handling Requests

To handle incoming requests in your worker and to send responses back, export a `handler()` function.  This function will be invoked once per request, and is passed an [args](#args) object containing everything you need to know about the request, and a callback.  Example use:

```js
// in my_worker.js
exports.handler = function(args, callback) {
	// handle request in child and fire callback
	callback( 
		"200 OK", 
		{ 'Content-Type': "text/html" }, 
		"Hello this is <b>custom</b> HTML content!\n" 
	);
};
```

As you can see the handler `callback()` accepts the standard 3 arguments from [pixl-server-web](https://npmjs.com/package/pixl-server-web#custom-uri-handlers) URI handlers (i.e. HTTP status, headers, and body).  However, you have more options available in worker scripts, including the ability to send back JSON (see [JSON Responses](#json-responses)), binary buffers (see [Binary Responses](#binary-responses)), or entire files (see [File Responses](#file-responses)).

#### args

The `args` object, passed to your worker `handler()` function, contains *almost* identical contents to the one in [pixl-server-web](https://www.npmjs.com/package/pixl-server-web#args), with a few notable exceptions:

- `args.request` is present, but it's not a real [http.IncomingMessage](https://nodejs.org/api/http.html#http_class_http_incomingmessage) object.
	- It has all the essentials, though (see below for details).
- `args.response` is present, but it's not a real [http.ServerResponse](https://nodejs.org/api/http.html#http_class_http_serverresponse) object.
	- Responses are handled differently in worker children, but the standard 3-arg callback still behaves as expected.  See below.
- `args.server` is missing (doesn't exist in child land).

The `args` object should still provide everything you need to serve the request, including:

| Property Path | Description |
|---------------|-------------|
| `args.cmd` | Specifies the type of request.  Will be `request` for normal web requests, or `custom` for custom ones (see [Sending Custom Requests](#sending-custom-requests)). |
| `args.id` | A unique identifier for the request, used internally to match it with the correct socket at response time. |
| `args.ip` | The socket IP address of the client connection. |
| `args.ips` | An array of all the client IP addresses, including those from the `X-Forwarded-For` header. |
| `args.url` | The fully-qualified request URL, including the HTTP protocol and hostname. |
| `args.request.method` | The request method, e.g. `GET`, `POST`, etc. |
| `args.request.url` | The request URI, sans protocol and hostname. |
| `args.request.headers` | An object containing all the request headers, keys lower-cased. |
| `args.request.httpVersion` | The HTTP protocol version, e.g. `1.1`. |
| `args.socket.remoteAddress` | An alias for `args.ip`. |
| `args.params` | All HTTP POST params, parsed JSON, etc. (see [args.params](https://npmjs.com/package/pixl-server-web#argsparams)). |
| `args.query` | The parsed query string as key/value pairs (see [args.query](https://npmjs.com/package/pixl-server-web#argsquery)). |
| `args.cookies` | The parsed cookie as key/value pairs (see [args.cookies](https://npmjs.com/package/pixl-server-web#argscookies)). |
| `args.files` | All uploaded files (see [args.files](https://www.npmjs.com/package/pixl-server-web#argsfiles)). |
| `args.perf` | A [pixl-perf](https://www.npmjs.com/package/pixl-perf) object you can use for tracking app performance (see [Performance Tracking](#performance-tracking)). |
| `args.response.type` | Specifies the response type, e.g. `string`, `base64`, `json` (see below). |
| `args.response.status` | The HTTP response code, e.g. `200 OK`, `404 Not Found`. |
| `args.response.headers` | The response headers (key/value pairs, mixed case). |
| `args.response.body` | The response body (String, Buffer, etc.).  See below. |

#### Text Responses

To send a text response from your worker, you can simply fire the callback with the standard 3 arguments from [pixl-server-web](https://npmjs.com/package/pixl-server-web#custom-uri-handlers) URI handlers (i.e. HTTP status, headers, and body).  Example:

```js
callback( 
	"200 OK", 
	{ 'Content-Type': "text/html" }, 
	"Hello this is <b>custom</b> HTML content!\n" 
);
```

Alternatively, you can set the following properties in the `args.response` object, and then fire the callback without any arguments.  Example:

```js
args.response.status = "200 OK";
args.response.headers['Content-Type'] = "text/html";
args.response.body = "Hello this is <b>custom</b> HTML content!\n";

callback();
```

#### Binary Responses

To send a binary response from your worker, you can use a [Buffer](https://nodejs.org/api/buffer.html) object.  However, depending on the size of the data, you may want to consider using a file instead (see [File Responses](#file-responses) below).  The reason is, your Buffer must be converted to [Base64](https://en.wikipedia.org/wiki/Base64) so it can be routed through JSON back to the parent process, where it is unpacked again.  For larger blobs, a file may be faster.

To send a Buffer, fire the callback with the standard 3 arguments from [pixl-server-web](https://npmjs.com/package/pixl-server-web#custom-uri-handlers) URI handlers, but pass the Buffer as the body (3rd argument).  Example:

```js
var buf = fs.readFileSync('binary-image.gif');

callback( 
	"200 OK", 
	{ 'Content-Type': "image/gif" }, 
	buf // binary buffer
);
```

Alternatively, you can set the following properties in the `args.response` object, and then fire the callback without any arguments.  Example:

```js
var buf = fs.readFileSync('binary-image.gif');

args.response.status = "200 OK";
args.response.headers['Content-Type'] = "image/gif";
args.response.body = buf; // binary buffer

callback();
```

#### JSON Responses

To send a JSON response, you can simply fire the callback and pass the object/array tree to be serialized as the sole argument.  Example:

```js
callback({ key1: "Value1", key2: "Value2" });
```

Alternatively, you can assign the object to the `args.response.body` property, and then fire the callback without any arguments.  Example:

```js
args.response.body = { key1: "Value1", key2: "Value2" };
callback();
```

These will automatically set response headers like `Content-Type: application/json`, including support for [JSONP](https://en.wikipedia.org/wiki/JSONP) (i.e. `callback` query parameter).

#### File Responses

If you need to stream an entire file back to the client, there is a special mechanism for doing so.  In your worker script you can set the response type to `file`, and then specify a filesystem path in `args.response.body`, along with any headers you want.  All this metadata is passed to the parent process as JSON, and then the file is opened and streamed from there to the client.  This is especially useful for large and/or binary files.  Example:

```js
args.response.type = "file";
args.response.status = "200 OK";
args.response.headers['Content-Type'] = "image/gif";
args.response.body = "/path/to/my/image.gif"; // file path

callback();
```

#### Error Responses

You can, of course, construct and send back your own custom error responses, but if you would prefer a generic one, simply send an `Error` object (or any subclass thereof) to your worker handler callback as the sole argument.  Example:

```js
var err = new Error("Something went wrong in a worker!");
callback( err );
```

This will be sent back to the client as an `HTTP 500 Internal Server Error`, with the response body set to the `Error` object cast to a string.  The error will also be logged to the main [pixl-server](https://www.npmjs.com/package/pixl-server) logging system (see [Logging](#logging) below).

#### Performance Tracking

If you want to track application performance in your workers, a [pixl-perf](https://www.npmjs.com/package/pixl-perf)) instance is made available to your handler function, in `args.perf`.  Metrics from this performance object are sent back to the main web server process, where they are logged (if [transaction logging](https://www.npmjs.com/package/pixl-server-web#logging) is enabled) and also exposed in the [getStats() API](https://www.npmjs.com/package/pixl-server-web#stats).

You can track metrics directly on the `args.perf` object like this:

```js
args.perf.begin('my_engine');
// do some work
args.perf.end('my_engine');
```

Or you can track metrics independently using your own [pixl-perf](https://www.npmjs.com/package/pixl-perf) instances, and import them into `args.perf` at the very end of the request, just before you fire the callback:

```js
var Perf = require('pixl-perf');
var my_perf = new Perf();

my_perf.begin('my_engine');
// do some work
my_perf.end('my_engine');

// end of request
args.perf.import( my_perf );

callback( "200 OK", {}, "Success!" );
```

#### Custom Worker URI Routing

You may want to perform URI routing in the child worker rather than, or in addition to, the parent web server process.  For example, your worker may serve multiple roles, activated by different URIs.  In this case you'd want to first route *all* applicable traffic to the worker, but then perform further routing into the correct API function in your worker script.

Here is how you can accomplish this.  First, setup your pool to capture all applicable URIs for your application, in the following example any URI that starts with `/pool`, either by using the `uri_match` property in your pool configuration, or by calling [addURIHandler()](https://www.npmjs.com/package/pixl-server-web#custom-uri-handlers) in the parent process.  Example of the former:

```js
"PoolManager": {
	"pools": {
		"MyTestPool": {
			"uri_match": "^/pool",
			"script": "my_worker.js"
		}
	}
}
```

Then, in your worker child script, you can further route more specific requests to individual URI handlers, by calling [Worker.addURIHandler()](#workeraddurihandler) in your exported `startup()` routine:

```js
// in my_worker.js

exports.startup = function(worker, callback) {
	// child is starting up
	this.worker = worker;
	
	// route certain URIs to different methods in child
	worker.addURIHandler( /^\/pool\/route1/, "Route 1", this.myAppRoute1.bind(this) );
	worker.addURIHandler( /^\/pool\/route2/, "Route 2", this.myAppRoute2.bind(this) );
	
	worker.addURIHandler( /^\/pool\/route3/, "Route 3", function(args, callback) {
		// handle this one inline
		callback( "200 OK", {}, "Route 3 completed!" );
	} );
	
	// startup is complete
	callback();
};

exports.myAppRoute1 = function(args, callback) {
	// this will be called for all /pool/route1 URIs
	callback( "200 OK", {}, "Route 1 completed!" );
};

exports.myAppRoute2 = function(args, callback) {
	// this will be called for all /pool/route2 URIs
	callback( "200 OK", {}, "Route 2 completed!" );
};
```

The idea here is that the [Worker.addURIHandler()](#workeraddurihandler) method provides a similar URI routing setup as the one in [pixl-server-web](https://www.npmjs.com/package/pixl-server-web#custom-uri-handlers), but performs the routing in the child worker itself.

Please note that if you require [ACL restrictions](https://npmjs.com/package/pixl-server-web#access-control-lists) you need to apply them in the parent (web server) process, and not in the child worker.

## Auto-Scaling

Auto-scaling is an optional feature that will actively monitor your child workers, and spawn new ones and/or kill off idle ones as needed, based on how busy they are.  This behavior is activated by setting the `min_children` and `max_children` pool configuration properties to different values.  Example:

```js
"PoolManager": {
	"pools": {
		"MyTestPool1": {
			"script": "my_worker.js",
			"uri_match": "^/pool1",
			"min_children": 2,
			"max_children": 10
		}
	}
}
```

This will spawn 2 children at startup, and always keep at least 2 children alive at all times.  Then, based on traffic, it may spawn 8 additional children (up to 10 total) as needed.  The system determines how busy children are by sampling them every tick (once per second), and checking if they are serving N or more concurrent requests (N is explained below).  If all children are considered busy, and we have less than `max_children` alive, more are spawned.  At the same time, if there are extra idle children sitting around doing nothing, they are killed off.

You can control what makes a child "busy" by adjusting the `child_busy_factor` property in your pool configuration.  This represents the threshold of concurrent requests being served by a single child.  If the child is serving this number or more, it is considered to be busy.  The default value is `1`.

The auto-scaling system follows these rules:

- Always ensure at least `min_children` workers are active.
- Never exceed `max_children` workers under any circumstances.
- Try to keep at least one idle worker (+headroom) available at all times.
- Only `max_concurrent_launches` workers are allowed to start up at one time.
- Only idle workers are considered for shutdown (those not serving *any* requests).
- Don't touch any workers in a maintenance state.

To disable auto-scaling entirely, simply set `min_children` and `max_children` to the same value.

### Child Headroom

By default, the system always tries to keep 1 idle child worker ready at all times, while still adhering to things like `max_children`.  So if one child is busy, another is always available to accept the next request (total busy plus one).  However, sometimes this is simply not enough.  For example, your workers may not start up instantly, so there may be a delay before additional workers can be made available when all current ones are busy.

To better prepare for random spikes of traffic, you can "over-allocate" a certain percentage of workers.  The `child_headroom_pct` pool configuration property adjusts the "number of busy workers" calculation by the specified percentage, so more can always be at the ready.  The system then takes this into consideration when deciding whether it needs to auto-scale or not.  The basic formula is:

```
TARGET_CHILDREN = NUM_BUSY + (NUM_BUSY * HEADROOM_PCT / 100) + 1
```

So `TARGET_CHILDREN` is the number of children we want to have active, and is calculated by first determining how many children are "busy" (see above), and then raising that number by the headroom percentage, and finally adding 1.  This value is then clamped by things like `min_children` and `max_children`.

For example, consider this configuration:

```js
"PoolManager": {
	"pools": {
		"MyTestPool1": {
			"script": "my_worker.js",
			"uri_match": "^/pool1",
			"min_children": 1,
			"max_children": 10,
			"child_headroom_pct": 50
		}
	}
}
```

Here we're asking for 1 to 10 children, with 50% headroom.  So if 4 children are busy, then 4 is divided by 2 (50%) and then added to the original 4, making 6.  The system would then make sure 7 children were active, because it's *total busy plus one*.   So then every tick it will spawn (or kill) children to arrive at that target number.

### Max Concurrent Requests

It is highly recommended that you set the `max_concurrent_requests` pool configuration property to the maximum number of simultaneous requests your application can serve, across all workers.  This value defaults to `0` which is basically unlimited.  If additional requests come in and your application is already serving `max_concurrent_requests` simultaneous requests, an [HTTP 429](#http-429-too-many-requests) response is sent.

So if your workers can only serve 1 concurrent request but your `max_children` is 10, then `max_concurrent_requests` should probably be 10 as well.  However, if your workers can serve multiple concurrent requests, feel free to increase `max_concurrent_requests` beyond your max children.  Note that the pooler does not provide any sort of queuing mechanism.  All requests are delegated to workers immediately.  You can, however, queue up requests in your worker script if you want.

This request limit can be somewhat governed by the [http_max_connections](https://www.npmjs.com/package/pixl-server-web#http_max_connections) setting in [pixl-server-web](https://www.npmjs.com/package/pixl-server-web), but that is talking about socket connections specifically.  A socket may be open but inactive (i.e. keep-alive), and also the pixl-server-pool module can run independently of pixl-server-web, hence the need for its own concurrent request limit.

### Max Requests Per Child

The `max_requests_per_child` pool configuration property sets the maximum number of requests a child will serve in its lifetime, before it is killed off and a new one spawned in its place.  The default is `0` which means infinite lifetime.  Increasing this can be used to curb things like memory leaks.  If your workers (or any of the libraries they use) leak memory, this allows you to keep them under control.

This property can be a single number, or a range of numbers.  The latter will pick a random number within the range for each child spawned.  To specify a range, set the property to a two-element array like this:

```js
"max_requests_per_child": [1000, 2000]
```

This would kill off children between 1000 to 2000 requests, randomly picked once per child.  The idea here is that you may not want all your children to cycle out at the same time, and would rather stagger them over a wider period.  This is especially important for production scale apps with heavy memory leaks, requiring a short worker lifespan.

## Rolling Maintenance Sweeps

If you need to temporarily take your workers offline to run maintenance on them (i.e. garbage collection or other), you can do that with a rolling maintenance sweep.  As long as you have multiple children, this should be a zero-downtime affair, as each child is taken out of rotation safely (well, up to `max_concurrent_maint` children at a time).  When maintenance is completed, the child is put back into live rotation.  You can control exactly what happens during maintenance, by declaring a special exported `maint()` function in your worker script.

You can request a rolling maintenance sweep yourself using the [WorkerPool.requestMaint()](#workerpoolrequestmaint) call, or you can have the system routinely schedule maintenance sweeps every N requests or N seconds.  Here is an example which fires it off via a web request ([ACL restricted](https://npmjs.com/package/pixl-server-web#access-control-lists) of course):

```js
// in main process
server.startup( function() {
	// server startup complete, get a ref to our worker pool
	var pool = server.PoolManager.getPool('MyTestPool1');
	
	// add URI handler for requesting a rolling maintenance sweep
	server.WebServer.addURIHandler( /^\/pool\/maint$/, 'Pool Maintenance', true, function(args, callback) {
		// custom request handler for our URI
		pool.requestMaint();
		
		// JSON response
		callback({ code: 0, description: "Rolling maintenance sweep scheduled successfully." });
	} );
} );
```

This would request a rolling maintenance sweep when a request comes in for the URI `/pool/maint`.  You obviously don't have to expose this via a web request -- this is just an example.  You can have your own internal code in the parent process decide when to call [WorkerPool.requestMaint()](#workerpoolrequestmaint), or you can have the system schedule automatic maintenance sweeps (see below).

After a maintenance sweep has been requested, the main ticker chooses one child at a time (up to `max_concurrent_maint` at once), and places it into maintenance mode.  This involves waiting for all its active requests to be completed, and then invoking your worker's `maint()` function, if defined.  Example:

```js
// in my_worker.js
exports.maint = function(user_data, callback) {
	// perform maintenance (garbage collection, etc.)
	callback();
};
```

You can rest assured that when your `maint()` function is called, your worker is **not** serving any other requests, so you are free to block the main thread, etc.  The child is essentially "offline" until the maintenance callback is fired.

Notice that the `maint()` function is passed two arguments: the standard callback, but also a `user_data` as the first argument.  This can be populated with whatever you want, if you pass it to [WorkerPool.requestMaint()](#workerpoolrequestmaint).  It allows you to run different kinds of maintenance routines based on what you pass in.

If you do not declare a `maint()` function in your worker script, the default action is to run Node.js garbage collection -- that is, if `global.gc` is exposed via the `--expose_gc` command-line flag on your main process (which is passed down to all worker children).  If not, no action is taken.

### Automatic Routine Maintenance

To schedule automatic maintenance sweeps, set the `auto_maint` pool configuration property to `true`, and then choose a timing method via `maint_method`.  You can opt to run maintenance every N requests served (`"requests"`), or every N seconds (`"time"`).  Example of the former:

```js
{
	"auto_maint": true,
	"maint_method": "requests",
	"maint_requests": 1000
}
```

This would run maintenance every 1,000 requests served (per each child).  Or, you can do it via worker elapsed time instead:

```js
{
	"auto_maint": true,
	"maint_method": "time",
	"maint_time_sec": 300
}
```

This would run maintenance every 300 seconds (5 minutes).  Note that both methods are calculated *per worker*.  This is important, because new children can be spawned at any time, and so their maintenance needs will differ from each other, especially if you are performing a task like garbage collection.

## Rolling Restarts

If you need to restart all your workers and replace them with new ones, you can do that with a rolling restart request.  As long as you have multiple children, this should be a zero-downtime affair, as each child is taken out of rotation individually (well, up to `max_concurrent_launches` children at a time).  You can request a rolling restart using the [WorkerPool.requestRestart()](#workerpoolrequestrestart) call.  Here is an example which fires it off via a web request ([ACL restricted](https://npmjs.com/package/pixl-server-web#access-control-lists) of course):

```js
// in main process
server.startup( function() {
	// server startup complete, get a ref to our worker pool
	var pool = server.PoolManager.getPool('MyTestPool1');
	
	// add URI handler for requesting a rolling restart
	server.WebServer.addURIHandler( /^\/pool\/restart$/, 'Pool Restart', true, function(args, callback) {
		// custom request handler for our URI
		pool.requestRestart();
		
		// JSON response
		callback({ code: 0, description: "Rolling restart scheduled successfully." });
	} );
} );
```

This would request a rolling restart when a request comes in for the URI `/pool/restart`.  You obviously don't have to expose this via a web request -- this is just an example.  You can have your own internal code in the parent process decide when to call [WorkerPool.requestRestart()](#workerpoolrequestrestart).

If you want to catch the worker shutdown and run your own cleanup code, simply export a `shutdown()` function in your worker script.  Note that it is passed a callback which you must fire, to signal that shutdown is complete and the process can exit.  Example:

```js
// in my_worker.js
exports.shutdown = function(callback) {
	// perform any necessary shutdown tasks here
	callback();
};
```

## Sending Custom Requests

Custom requests offer the ability for you to send a completely user-defined request to your worker pool, and then capture the response, all potentially outside of a normal HTTP request workflow.  The contents of the request and the response are entirely up to your code.  So instead of "handing off" an HTTP request to a worker child, you're just passing it a custom user-defined object, and receiving one in return.  Custom requests are sent using the [WorkerPool.delegateCustom()](#workerpooldelegatecustom) method.

One potential use of custom requests is to handle most of your application logic in the parent web process, i.e. parse the HTTP request, perform things like authentication, database queries, etc., but then delegate a smaller side task to a worker pool.  For example, a CPU-hard image transformation, or some operation that requires process-level parallelization.  Then, handle the HTTP response back in the parent process.

Here is an example.  This code snippet runs in the parent (web server) process, and assumes you have a `pool` variable in scope, which was attained by calling [PoolManager.getPool()](#poolmanagergetpool).

```js
// in main web server process
var user_req = {
	// custom request object, can contain anything you want
	myKey1: "My Value 1",
	myComplexObject: [ 1, 2, "Three", { Four: 4 } ]
};

// send custom request to a worker
pool.delegateCustom( user_req, function(err, user_resp) {
	// got response back from worker
	if (err) {
		// handle error
	}
	// 'user_resp' is custom user-defined object passed to callback from worker
	console.log( user_resp.myRespKey1, user_resp.myRespKey2 );
} );
```

Please note that your user-defined request object must be able to survive serialization to/from JSON.  So please use only JavaScript primitives, like objects, arrays, strings, numbers and/or booleans.

The callback is passed an `Error` object (see [Custom Request Errors](#custom-request-errors) below) or `null` for success, and a user-defined response object, which is entirely dictated by your user code in your worker script.

In your worker script, every custom request arrives by firing your exported `custom()` function.  It is passed a minimal `args` object and a callback, similar to a web request.  Example:

```js
// in my_worker.js
exports.custom = function(args, callback) {
	// handle custom request in child and fire callback
	// 'args.params' is the user_req object
	// in this example: args.params.myKey1 and args.params.myComplexObject
	
	// fire callback with null for no error, and a custom response object
	callback( null, { myRespKey1: "My Response Value 1", myRespKey2: 12345 } );
};
```

As you can see, `args.params` contains everything passed in the `user_req` object demonstrated above.  See [Custom Request Args](#custom-request-args) for a list of everything available in `args.  After completing your custom work, fire the callback with an `Error` if one occurred (or `null`/`false` if not) and a custom user-defined response object, which will be passed back to the calling code in the parent web process.  Your user-defined response object must also be able to survive serialization to/from JSON.  So please use only JavaScript primitives, like objects, arrays, strings, numbers and/or booleans.

Please note that custom requests still count against the worker's [Max Requests Per Child](#max-requests-per-child), and the pooler still honor things like [Max Concurrent Requests](#max-concurrent-requests).  A single worker is still chosen from the pool using the [Worker Selection Algorithm](#worker-selection-algorithm), and only idle workers (those not starting up, shutting down or in maintenance mode) are picked.  The only real difference here is that a custom request isn't HTTP specific -- it is 100% user defined, in both the request and the response.

### Custom Request Args

The custom request version of the `args` object is pretty minimal, compared to the main [args](#args) used in web requests.  Here is everything that is provided:

| Property Path | Description |
|---------------|-------------|
| `args.cmd` | Specifies the type of request, which will always be `custom` in this case. |
| `args.id` | A unique identifier for the request, used internally to match it up with the correct calling thread. |
| `args.params` | A copy of your user-defined request object, which you passed to [WorkerPool.delegateCustom()](#workerpooldelegatecustom). |
| `args.perf` | A [pixl-perf](https://www.npmjs.com/package/pixl-perf) object you can use for tracking app performance (see [Performance Tracking](#performance-tracking)). |

When using `args.perf` for tracking performance in your worker custom requests, please note that the metrics aren't logged or used in the web server process at all, like they are with delegated web requests.  For custom requests, you have to explicitly receive the performance object, and log or otherwise use the metrics yourself.  `args.perf` is passed to the [WorkerPool.delegateCustom](#workerpooldelegatecustom) callback as the 3rd argument, after your custom response object:

```js
pool.delegateCustom( user_req, function(err, user_resp, perf) {
	// got response back from worker
	if (err) {
		// handle error
	}
	// 'perf' is a pixl-perf object containing metrics for the custom request
	console.log( perf.metrics() );
} );
```

The performance object will contain one `worker` metric, which is the total round-trip time from parent to worker to parent.  It will also contain any of your own metrics, if you you added them in your worker script.  See [Performance Tracking](#performance-tracking) for more details.

### Custom Request Errors

A number of errors may be emitted when using custom requests.  These will be passed into to your [WorkerPool.delegateCustom](#workerpooldelegatecustom) callback as the first argument.  The errors will all have a `code` property (string), as well as a standard `message`.  Here are the possibilities:

| Error Code | Description |
|------------|-------------|
| `429 Too Many Requests` | Too many simultaneous requests being served (i.e. `max_concurrent_requests`). |
| `500 Internal Server Error` | An error occurred in the child worker (see below). |
| `503 Service Unavailable` | No worker available (should never happen, see [HTTP 503](#http-503-service-unavailable) below). |
| `504 Gateway Timeout` | The request took too long and timed out (i.e. `request_timeout_sec`). |

Of course, the error may be generated from your worker script (as in, you passed an `Error` object to the callback as the first argument).  In this case, the error is converted to a `500 Internal Server Error`, and a string representation of your error is passed as the `message` property.

## Sending Custom Pool Messages

If you need to notify all your workers about something (e.g. configuration file changed, force cache flush, etc.) you can broadcast a custom message to them.  Unlike [custom requests](#sending-custom-requests), messages are broadcast to *all workers simultaneously*, and it is stateless.  A custom message cannot be directly "responded" to like a request can.  You can have workers send separate messages back to the parent process (see below), which can be caught by listening for the [message](#message) event, but those messages are inherently disconnected from any previous message.

To broadcast a custom message to all pool workers, use the [WorkerPool.sendMessage()](#workerpoolsendmessage) method.  Example:

```js
// in main web server process
pool.sendMessage({ myKey1: 12345, myKey2: "Custom!" });
```

This code snippet runs in the parent (web server) process, and assumes you have a `pool` variable in scope, which was attained by calling [PoolManager.getPool()](#poolmanagergetpool).

You can pass any user-defined object as the message, as long as it is able to survive serialization to/from JSON.  So please use only JavaScript primitives, like objects, arrays, strings, numbers and/or booleans.  Note that there is no callback here (messages are fire-and-forget).

In your worker script, custom messages arrive via your exported `message()` function, with the user-defined message object as the sole argument.  Note that *all workers* in the pool are sent the same message simultaneously.  Example:

```js
// in my_worker.js
exports.message = function(user_data) {
	// received custom message
	// 'user_data` is whatever object was passed to pool.sendMessage()
	// in this example: user_data.myKey1, user_data.myKey2
};
```

Again, notice that there is no callback here.  Messages are one-way deals.  That being said, there is an API for sending *separate* messages from workers back to the parent web server process.  See below for details on this.

Please note that messages do not care what state the worker is in.  Even if the child is in the middle of maintenance, or startup or shutdown, the message will still be sent, and the worker's `message()` function will be called, as soon as the Node.js event loop has an available thread in the child process.  You can, of course, choose to ignore the message or delay acting on it in your own code.

Custom messages also do not count against the [Max Requests Per Child](#max-requests-per-child) counter, and [Max Concurrent Requests](#max-concurrent-requests) is ignored entirely as sell.

### Custom Worker-Sent Messages

In addition to broadcasting messages from the pool to all workers, you can send messages in the reverse direction as well, i.e. from a worker to the parent web process.  This is done by calling the [Worker.sendMessage()](#workersendmessage) method in your worker script.

To use this API, first make sure you store a copy of the [Worker](#worker) object initially passed to your exported `startup()` function:

```js
// in my_worker.js
exports.startup = function(worker, callback) {
	// child is starting up, save reference to worker
	this.worker = worker;
	callback();
};
```

Now you can invoke methods on `this.worker` whenever you want, even outside of a request workflow (i.e. from a timer or other event).  Here is an example of sending a custom message from the worker to the parent web process:

```js
// in my_worker.js
this.worker.sendMessage({ myWorkerKey1: 12345, myWorkerKey2: "Hello" });
```

As with [Sending Custom Pool Messages](#sending-custom-pool-messages), the [Worker.sendMessage()](#workersendmessage) accepts any user-defined object as its sole argument.  There is no callback (messages are one-way and fire-and-forget).

Back in the main (web server) process, worker-sent messages are received in the [WorkerPool](#workerpool) object and a [message](#message) event is emitted (`WorkerPool` is an [EventEmitter](https://nodejs.org/api/events.html#events_class_eventemitter)).  Here is how to listen for it:

```js
// in main web server process
pool.on('message', function(message) {
	// received message sent from worker
	// message.pid is the PID of the sender
	// message.data is the raw user-defined data
	// in this example: message.data.myWorkerKey1, message.data.myWorkerKey2
});
```

This code snippet runs in the parent (web server) process, and assumes you have a `pool` variable in scope, which was attained by calling [PoolManager.getPool()](#poolmanagergetpool).

So here we're using [WorkerPool.on()](#workerpoolon) to register an event listener for the [message](#message) event.  Note that it is passed a single object which contains both the PID of the worker process which sent the message, and the raw message object itself (user-defined).

The PID can be useful because you can pass it to [WorkerPool.getWorker()](#workerpoolgetworker) to retrieve the actual worker object itself.

## Events

The [WorkerPool](#workerpool) class is an [EventEmitter](https://nodejs.org/api/events.html#events_class_eventemitter), and can emit the following events:

### message

The `message` event is emitted when a worker sends a custom message back to the parent (web server) process.  The message itself is an object containing the PID of the sender (`pid`) and the user data itself (`data`).  See [Custom Worker-Sent Messages](#custom-worker-sent-messages) above for details.

### autoscale

The `autoscale` event is emitted whenever the worker pool is scaling up (adding a worker) or scaling down (removing a worker).  The event object will contain:

| Property | Description |
|----------|-------------|
| `cmd` | Will be set to either `"add"` or `"remove"`. |
| `pid` | The PID of the worker being added or removed. |

Example:

```js
pool.on('autoscale', function(event) {
	// an auto-scale event is taking place.
	// event.cmd will be either "add" or "remove".
	// event.pid is the PID of the worker being added or removed.
});
```

### maint

The `maint` event is emitted whenever maintenance is starting on a worker.  For a [Rolling Maintenance Sweep](#rolling-maintenance-sweeps) this event will be emitted once for every worker.  The event object is the [WorkerProxy](#workerproxy) representing the worker.  Example:

```js
pool.on('maint', function(worker) {
	// maintenance is being performed on a worker
	console.log( worker.pid );
});
```

### restart

The `restart` event is emitted whenever a worker is being restarted, or simply shut down.  This can happen if a worker reaches the end of its lifespan (see [Max Requests Per Child](#max-requests-per-child)), or upon request.  For a [Rolling Restart](#rolling-restarts) request this event will be emitted once for every worker.  The event object is the [WorkerProxy](#workerproxy) representing the worker.  Example:

```js
pool.on('restart', function(worker) {
	// worker is being restarted or shut down
	console.log( worker.pid );
});
```

Note that the worker is actually shut down entirely, and may be replaced with a new worker, with a new PID.  The [autoscale](#autoscale) event should also fire in this case.

## API

This section is a reference for all classes and methods.

### PoolManager

The `PoolManager` class is a singleton, and is the main [pixl-server](https://npmjs.com/package/pixl-server) component which runs the pool show.  It manages all worker pools, and provides the main entry point for API calls.  You can gain access via the `PoolManager` property in the main server object.  Example:

```js
// in main web server process
var poolmgr = server.PoolManager;
```

This code snippet assumes your [pixl-server](https://npmjs.com/package/pixl-server) instance is in scope and named `server`.

#### PoolManager.getPool

The `getPool()` method retrieves a [WorkerPool](#workerpool) object given its ID.  The ID is user-defined, from your pool configuration.  Example:

```js
// in main web server process
var pool = server.PoolManager.getPool('MyTestPool1');
```

This code snippet assumes your [pixl-server](https://npmjs.com/package/pixl-server) instance is in scope and named `server`.

### WorkerPool

The `WorkerPool` class represents one pool of workers.  It can be retrieved by calling [PoolManager.getPool()](#poolmanagergetpool).

#### WorkerPool.delegateRequest

The `WorkerPool.delegateRequest()` method delegates a web request to a worker pool.  It picks a suitable worker using the [Worker Selection Algorithm](#worker-selection-algorithm).  It should be passed the [args](https://www.npmjs.com/package/pixl-server-web#args) object from [pixl-server-web](https://www.npmjs.com/package/pixl-server-web), and the web callback.  Example:

```js
// in main web server process
server.startup( function() {
	// server startup complete, get a ref to our worker pool
	var pool = server.PoolManager.getPool('MyTestPool1');
	
	// add handler for our URI (runs in main process)
	server.WebServer.addURIHandler( /^\/pool1/, 'My Pool', function(args, callback) {
		// custom request handler for our URI
		// delegate request to worker pool (handles response as well)
		pool.delegateRequest( args, callback );
	} );
} );
```

This code snippet assumes you have a preconfigured worker pool named `MyTestPool1`, and your [pixl-server](https://npmjs.com/package/pixl-server) instance is in scope and named `server`.

You can also intercept the response from the worker by providing your own callback.  See [Manual Request Routing](#manual-request-routing) for more details.

#### WorkerPool.delegateCustom

The `WorkerPool.delegateCustom()` method sends a custom request to a worker pool (i.e. not web-related).  It picks a suitable worker using the [Worker Selection Algorithm](#worker-selection-algorithm).  You can pass any custom user-defined object, as long as it can be JSON serialized.  Example:

```js
// in main web server process
// send custom request to a worker
pool.delegateCustom( { custom1: 12345, custom2: "Hello" }, function(err, user_resp) {
	// got response back from worker
	if (err) {
		// handle error
	}
	// 'user_resp' is custom user-defined object passed to callback from worker
} );
```

This code snippet assumes you have a `pool` variable in scope, which was attained by calling [PoolManager.getPool()](#poolmanagergetpool).

See [Sending Custom Requests](#sending-custom-requests) for more details.

#### WorkerPool.sendMessage

The `WorkerPool.sendMessage()` method broadcasts a custom message to *all* workers simultaneously.  Message sending is a stateless system with no callbacks (messages are one-way and fire-and-forget).  Example:

```js
// in main web server process
pool.sendMessage({ myKey1: 12345, myKey2: "Custom!" });
```

This code snippet assumes you have a `pool` variable in scope, which was attained by calling [PoolManager.getPool()](#poolmanagergetpool).

See [Sending Custom Pool Messages](#sending-custom-pool-messages) for more details.

#### WorkerPool.requestMaint

The `WorkerPool.requestMaint()` method requests a rolling maintenance sweep across all workers.  The pooler will then choose up to `max_concurrent_maint` workers per tick, take them out of service, run maintenance, and then put them back in.  Example:

```js
// in main web server process
pool.requestMaint();
```

You can optionally pass in custom user-defined object, which is sent all the way to the exported `maint()` function in your worker script (note that it must be JSON-safe).  Example:

```js
// in main web server process
pool.requestMaint({ myKey1: 12345, myKey2: "Maint!" });
```

These code snippets assume you have a `pool` variable in scope, which was attained by calling [PoolManager.getPool()](#poolmanagergetpool).

Note that if you only have one active worker child, this call has no effect.  The system will only send children into maintenance mode if there are more available to service requests.

See [Rolling Maintenance Sweeps](#rolling-maintenance-sweeps) for more details.

#### WorkerPool.requestRestart

The `WorkerPool.requestRestart()` method requests a rolling restart of all workers.  The pooler will choose up to `max_concurrent_launches` workers per tick, shut them down, and the auto-scaler will replace them with new ones.  Example:

```js
// in main web server process
pool.requestRestart();
```

This code snippet assumes you have a `pool` variable in scope, which was attained by calling [PoolManager.getPool()](#poolmanagergetpool).

Note that if you only have one active worker child, this call has no effect.  The system will only restart children if there are more available to service requests.

See [Rolling Restarts](#rolling-restarts) for more details.

#### WorkerPool.getWorkers

The `WorkerPool.getWorkers` method returns an object containing all current workers in the pool.  The object's keys are the worker PIDs, and the values are [WorkerProxy](#workerproxy) objects.  Example:

```js
// in main web server process
var workers = pool.getWorkers();
```

This code snippet assumes you have a `pool` variable in scope, which was attained by calling [PoolManager.getPool()](#poolmanagergetpool).

#### WorkerPool.getWorker

The `WorkerPool.getWorker()` method fetches a single worker from the pool, given its PID.  The response is a [WorkerProxy](#workerproxy) object.  To determine the PIDs of all workers, see [WorkerPool.getWorkers()](#workerpoolgetworkers) above.  Example:

```js
// in main web server process
var worker = pool.getWorker( 1234 ); // pid
```

This code snippet assumes you have a `pool` variable in scope, which was attained by calling [PoolManager.getPool()](#poolmanagergetpool).

#### WorkerPool.on

The `WorkerPool.on()` method is inherited from the Node.js [EventEmitter](https://nodejs.org/api/events.html#events_class_eventemitter) class.  It allows you to add listeners for events emitted on your [WorkerPool](#workerpool) objects.  Example:

```js
// in main web server process
pool.on('maint', function(worker) {
	// maintenance is being performed on a worker
	console.log( worker.pid );
});
```

This code snippet assumes you have a `pool` variable in scope, which was attained by calling [PoolManager.getPool()](#poolmanagergetpool).

See [Events](#events) for a list of all available events you can listen for.

### WorkerProxy

The `WorkerProxy` class represents one single worker in a pool, but runs in the main (web server) process.  It links to the actual child process via STDIN/STDOUT pipes.  You can fetch all the `WorkerProxy` objects for all workers in a pool by calling [WorkerPool.getWorkers()](#workerpoolgetworkers).

#### WorkerProxy.delegateRequest

The `WorkerProxy.delegateRequest()` method delegates a web request to a specific worker.  It bypasses the [Worker Selection Algorithm](#worker-selection-algorithm) and targets the exact worker you call it on.  This is an advanced function and should be used with great care.  It should be passed the [args](https://www.npmjs.com/package/pixl-server-web#args) object from [pixl-server-web](https://www.npmjs.com/package/pixl-server-web), and the web callback.  Example:

```js
// in main web server process
server.startup( function() {
	// server startup complete, get a ref to our worker pool
	var pool = server.PoolManager.getPool('MyTestPool1');
	
	// add handler for our URI (runs in main process)
	server.WebServer.addURIHandler( /^\/pool1/, 'My Pool', function(args, callback) {
		// custom request handler for our URI
		// delegate request to specific worker in pool (handles response as well)
		var worker = pool.getWorker( 1234 ); // PID
		worker.delegateRequest( args, callback );
	} );
} );
```

This code snippet assumes you have a preconfigured worker pool named `MyTestPool1`, and your [pixl-server](https://npmjs.com/package/pixl-server) instance is in scope and named `server`.

#### WorkerProxy.delegateCustom

The `WorkerProxy.delegateCustom()` method sends a custom request to a specific worker.  It bypasses the [Worker Selection Algorithm](#worker-selection-algorithm) and targets the exact worker you call it on.  This is an advanced function and should be used with great care.  You can pass any custom user-defined object, as long as it can be JSON serialized.  Example:

```js
// in main web server process
var worker = pool.getWorker( 1234 ); // PID

// send custom request to a specific worker
worker.delegateCustom( { custom1: 12345, custom2: "Hello" }, function(err, user_resp) {
	// got response back from worker
	if (err) {
		// handle error
	}
	// 'user_resp' is custom user-defined object passed to callback from worker
} );
```

This code snippet assumes you have a `pool` variable in scope, which was attained by calling [PoolManager.getPool()](#poolmanagergetpool).

#### WorkerProxy.sendMessage

The `WorkerProxy.sendMessage()` method sends a custom message to a *single* worker.  Message sending is a stateless system with no callbacks (messages are one-way and fire-and-forget).  Example:

```js
// in main web server process
var worker = pool.getWorker( 1234 ); // PID
worker.sendMessage({ myKey1: 12345, myKey2: "Custom!" });
```

This code snippet assumes you have a `pool` variable in scope, which was attained by calling [PoolManager.getPool()](#poolmanagergetpool).

#### WorkerProxy.shutdown

The `WorkerProxy.shutdown()` method shuts down a worker (kills the child process and removes the worker from the pool once it has exited).  This is an advanced / internal method used by the auto-scaler, and should only be called if you know exactly what you are doing.  Note that the auto-scaler may spawn a new child as soon as one is shut down, to maintain the desired number of workers in the pool.  Example:

```js
// in main web server process
var worker = pool.getWorker( 1234 ); // PID
worker.shutdown();
```

### Worker

The `Worker` object is a singleton that runs in every child worker process.  It handles all the communication with the parent process, and calls your worker script exported functions when necessary.  It also provides a few API calls and properties you can access.

The object is passed to your exported `startup()` function in your worker script.  It is recommended that you save this so you can access it later.  Example:

```js
// in my_worker.js
exports.startup = function(worker, callback) {
	// child is starting up, save reference to worker
	this.worker = worker;
	callback();
};
```

#### Worker.config

The `Worker.config` property is a copy of the worker pool's configuration object (containing properties like `max_children`, `max_requests_per_child`, etc.).  It also contains an `id` property which is the Pool's ID (configuration object key).

#### Worker.addURIHandler

The `Worker.addURIHandler()` method allows you to add URI routing in your worker script, as opposed to (or in addition to) URI routing in the main (web server) process.  The calling convention is similar to [pixl-server-web](https://www.npmjs.com/package/pixl-server-web#custom-uri-handlers).  Example:

```js
// in my_worker.js
exports.startup = function(worker, callback) {
	// child is starting up
	this.worker = worker;
	
	// route specific URI to method in worker script
	worker.addURIHandler( /^\/pool\/route1/, "Route 1", this.myAppRoute1.bind(this) );
	
	// startup is complete
	callback();
};

exports.myAppRoute1 = function(args, callback) {
	// this will be called for all /pool/route1 URIs
	callback( "200 OK", {}, "Route 1 completed!" );
};
```

See [Custom Worker URI Routing](#custom-worker-uri-routing) for more details.

#### Worker.sendMessage

The `Worker.sendMessage()` method sends a custom user-defined message from your worker script back to the main (web server) process.  It is captured by the worker pool object and emitted as a [message](#message) event.  Example:

```js
// in my_worker.js
this.worker.sendMessage({ myWorkerKey1: 12345, myWorkerKey2: "Hello" });
```

As with [Sending Custom Pool Messages](#sending-custom-pool-messages), the [Worker.sendMessage()](#workersendmessage) accepts any user-defined object as its sole argument.  This is no callback (messages are one-way and fire-and-forget).

See [Custom Worker-Sent Messages](#custom-worker-sent-messages) for more details.

## Client Errors

The following HTTP errors may be sent to your clients in certain situation.  Here is an explanation of when and why each can occur.

### HTTP 403 Forbidden

The `HTTP 403 Forbidden` error is sent back to clients if an incoming request fails the ACL check.  This is only applicable if you use the `uri_match` and `acl` features in your pool configuration, and an incoming request bound for your worker pool is from an IP address outside the ACL.

### HTTP 429 Too Many Requests

The `HTTP 429 Too Many Requests` error is sent back to clients if too many simultaneous requests are being served by your worker pool.  This limit is set via the `max_concurrent_requests` pool configuration property. 

### HTTP 500 Internal Server Error

The `HTTP 500 Internal Server Error` error is sent back to clients if one of the following situations occur:

- A worker (child process) crashes with active pool requests.
- A worker attempts to [proxy a file response](#file-responses) and the specified file cannot be read.
- A worker explicitly passes an `Error` object to the request callback.

### HTTP 503 Service Unavailable

The `HTTP 503 Service Unavailable` error should theoretically never happen.  It means that an available worker could not be found to service a pool request.  The only way this can ever happen is if every single worker is otherwise tied up in states such as maintenance, startup or shutdown.

Great care has been taken to ensure that these situations never occur, even with auto-scaling and rolling maintenance / restarts.  However, if you are only running a single child for some reason, or too many children exit at once and the system cannot spawn new ones quickly enough, a 503 error *may* occur.

Make sure you always have plenty of workers available, and use the `child_headroom_pct` feature to over-allocate as well.

### HTTP 504 Gateway Timeout

The `HTTP 504 Gateway Timeout` error is sent back to clients if a worker takes too long to service a request.  This timeout is set via the `request_timeout_sec` pool configuration property. 

## Logging

The pooler uses the logging system built into [pixl-server](https://www.npmjs.com/package/pixl-server-pool).  The `component` column will be set to either `PoolManager` or `Pool-[ID]` (where `[ID]` is the ID of your worker pool).  Most debug messages are pool-specific.

Here is an example log excerpt showing a typical startup with one pool (`TestPool`) and 2 workers.  In all these log examples the first 3 columns (`hires_epoch`, `date` and `hostname`) are omitted for display purposes.  The columns shown are `component`, `category`, `code`, `msg`, and `data`.

```
[PoolManager][debug][3][pixl-server-pool v1.0.0 starting up][]
[Pool-TestPool][debug][2][Starting up pool][{"enabled":true,"script":"my_child.js","uri_match":"^/pool","min_children":2,"max_children":10,"max_concurrent_requests":10,"max_requests_per_child":0,"startup_timeout_sec":10,"id":"TestPool","exec_path":"","exec_args":[],"exec_env":{},"exec_opts":{},"max_concurrent_launches":1,"max_concurrent_maint":1,"child_headroom_pct":0,"child_busy_factor":1,"shutdown_timeout_sec":10,"request_timeout_sec":0,"maint_timeout_sec":0,"auto_maint":false,"maint_method":"requests","maint_requests":1000,"maint_time_sec":0,"acl":false}]
[Pool-TestPool][debug][4][Worker starting up][]
[Pool-TestPool][debug][4][Spawned new child process: 6334][{"cmd":"/usr/local/bin/node","args":["/Users/jhuckaby/node_modules/pixl-server-pool/worker.js"],"script":"my_child.js"}]
[Pool-TestPool][debug][5][Current worker states][{"startup":1}]
[Pool-TestPool][debug][5][Worker 6334 startup complete, ready to serve][]
[Pool-TestPool][debug][5][Worker 6334 changing state from 'startup' to 'active'][]
[Pool-TestPool][debug][5][Current worker states][{"active":1}]
[Pool-TestPool][debug][4][Worker starting up][]
[Pool-TestPool][debug][4][Spawned new child process: 6335][{"cmd":"/usr/local/bin/node","args":["/Users/jhuckaby/node_modules/pixl-server-pool/worker.js"],"script":"my_child.js"}]
[Pool-TestPool][debug][5][Current worker states][{"active":1,"startup":1}]
[Pool-TestPool][debug][5][Worker 6335 startup complete, ready to serve][]
[Pool-TestPool][debug][5][Worker 6335 changing state from 'startup' to 'active'][]
[Pool-TestPool][debug][5][Current worker states][{"active":2}]
[Pool-TestPool][debug][2][Pool startup complete][]
```

Here is a single delegated web request (most of this is logged by [pixl-server-web](https://www.npmjs.com/package/pixl-server-web)):

```
[WebServer][debug][8][New incoming HTTP connection: c8][{"ip":"::ffff:127.0.0.1","num_conns":1}]
[WebServer][debug][8][New HTTP request: GET /pool/json?foo=bar (::ffff:127.0.0.1)][{"socket":"c8","version":"1.1"}]
[WebServer][debug][9][Incoming HTTP Headers:][{"host":"127.0.0.1:3012","user-agent":"curl/7.54.0","accept":"*/*"}]
[WebServer][debug][6][Invoking handler for request: GET /pool/json: TestPool][]
[Pool-TestPool][debug][9][Chose worker: 6535 for request: /pool/json?foo=bar][]
[WebServer][debug][9][Sending HTTP response: 200 OK][{"Content-Type":"application/json","X-JoeTest":1234,"Server":"Test Server 1.0","Content-Length":90}]
[WebServer][debug][9][Request complete][]
[WebServer][debug][9][Response finished writing to socket][]
[WebServer][debug][9][Request performance metrics:][{"scale":1000,"perf":{"total":2.744,"read":0.011,"process":2.022,"worker":1.649,"write":0.685},"counters":{"bytes_in":95,"bytes_out":201,"num_requests":1}}]
[WebServer][debug][9][Closing socket: c8][]
[WebServer][debug][8][HTTP connection has closed: c8][{"ip":"::ffff:127.0.0.1","total_elapsed":10,"num_requests":1,"bytes_in":95,"bytes_out":201}]
```

Here is an example of a rolling maintenance sweep:

```
[Pool-TestPool][debug][4][Beginning rolling maintenance of all workers in pool][]
[Pool-TestPool][debug][3][Peforming maintenance on worker: 6631][]
[Pool-TestPool][debug][4][Worker 6631 entering maintenance mode][]
[Pool-TestPool][debug][6][Sending 'maint' command to process: 6631][]
[Pool-TestPool][debug][5][Worker 6631 changing state from 'active' to 'maint'][]
[Pool-TestPool][debug][5][Current worker states][{"active":1,"maint":1}]
[Pool-TestPool][debug][4][Maintenance complete on child: 6631][]
[Pool-TestPool][debug][5][Worker 6631 changing state from 'maint' to 'active'][]
[Pool-TestPool][debug][5][Current worker states][{"active":2}]
[Pool-TestPool][debug][3][Peforming maintenance on worker: 6630][]
[Pool-TestPool][debug][4][Worker 6630 entering maintenance mode][]
[Pool-TestPool][debug][6][Sending 'maint' command to process: 6630][]
[Pool-TestPool][debug][5][Worker 6630 changing state from 'active' to 'maint'][]
[Pool-TestPool][debug][5][Current worker states][{"maint":1,"active":1}]
[Pool-TestPool][debug][4][Maintenance complete on child: 6630][]
[Pool-TestPool][debug][5][Worker 6630 changing state from 'maint' to 'active'][]
[Pool-TestPool][debug][5][Current worker states][{"active":2}]
```

Here is a auto-scale event, showing what is logged when a new worker is added to the pool:

```

[Pool-TestPool][debug][4][Auto-Scale: Adding worker to pool][{"num_busy":0}]
[Pool-TestPool][debug][4][Worker starting up][]
[Pool-TestPool][debug][4][Spawned new child process: 6606][{"cmd":"/usr/local/bin/node","args":["/Users/jhuckaby/node_modules/pixl-server-pool/worker.js"],"script":"my_child.js"}]
[Pool-TestPool][debug][5][Current worker states][{"maint":1,"active":1,"startup":1}]
[Pool-TestPool][debug][5][Worker 6606 startup complete, ready to serve][]
[Pool-TestPool][debug][5][Worker 6606 changing state from 'startup' to 'active'][]
[Pool-TestPool][debug][5][Current worker states][{"maint":1,"active":2}]
```

Here is another auto-scale event, removing an idle worker:

```
[Pool-TestPool][debug][4][Auto-Scale: Removing idle worker: 6535][{"num_busy":0}]
[Pool-TestPool][debug][4][Worker 6535 shutting down (6 requests served)][]
[Pool-TestPool][debug][6][Sending 'shutdown' command to process: 6535][]
[Pool-TestPool][debug][5][Worker 6535 changing state from 'active' to 'shutdown'][]
[Pool-TestPool][debug][5][Current worker states][{"shutdown":1,"active":2}]
[Pool-TestPool][debug][4][Child 6535 exited with code: 0][]
[Pool-TestPool][debug][4][Worker 6535 has been removed from the pool][]
[Pool-TestPool][debug][5][Current worker states][{"active":2}]
```

Here is a rolling restart sequence:

```
[Pool-TestPool][debug][4][Beginning rolling restart of all workers in pool][]
[Pool-TestPool][debug][3][Restarting worker 6606 upon request][]
[Pool-TestPool][debug][4][Worker 6606 shutting down (0 requests served)][]
[Pool-TestPool][debug][6][Sending 'shutdown' command to process: 6606][]
[Pool-TestPool][debug][5][Worker 6606 changing state from 'active' to 'shutdown'][]
[Pool-TestPool][debug][5][Current worker states][{"shutdown":1,"active":1}]
[Pool-TestPool][debug][4][Auto-Scale: Adding worker to pool][{"num_busy":0}]
[Pool-TestPool][debug][4][Worker starting up][]
[Pool-TestPool][debug][4][Spawned new child process: 6615][{"cmd":"/usr/local/bin/node","args":["/Users/jhuckaby/node_modules/pixl-server-pool/worker.js"],"script":"my_child.js"}]
[Pool-TestPool][debug][5][Current worker states][{"shutdown":1,"active":1,"startup":1}]
[Pool-TestPool][debug][4][Child 6606 exited with code: 0][]
[Pool-TestPool][debug][4][Worker 6606 has been removed from the pool][]
[Pool-TestPool][debug][5][Current worker states][{"active":1,"startup":1}]
[Pool-TestPool][debug][5][Worker 6615 startup complete, ready to serve][]
[Pool-TestPool][debug][5][Worker 6615 changing state from 'startup' to 'active'][]
[Pool-TestPool][debug][5][Current worker states][{"active":2}]
[Pool-TestPool][debug][3][Restarting worker 6607 upon request][]
[Pool-TestPool][debug][4][Worker 6607 shutting down (0 requests served)][]
[Pool-TestPool][debug][6][Sending 'shutdown' command to process: 6607][]
[Pool-TestPool][debug][5][Worker 6607 changing state from 'active' to 'shutdown'][]
[Pool-TestPool][debug][5][Current worker states][{"shutdown":1,"active":1}]
[Pool-TestPool][debug][4][Auto-Scale: Adding worker to pool][{"num_busy":0}]
[Pool-TestPool][debug][4][Worker starting up][]
[Pool-TestPool][debug][4][Spawned new child process: 6616][{"cmd":"/usr/local/bin/node","args":["/Users/jhuckaby/node_modules/pixl-server-pool/worker.js"],"script":"my_child.js"}]
[Pool-TestPool][debug][5][Current worker states][{"shutdown":1,"active":1,"startup":1}]
[Pool-TestPool][debug][4][Child 6607 exited with code: 0][]
[Pool-TestPool][debug][4][Worker 6607 has been removed from the pool][]
[Pool-TestPool][debug][5][Current worker states][{"active":1,"startup":1}]
[Pool-TestPool][debug][5][Worker 6616 startup complete, ready to serve][]
[Pool-TestPool][debug][5][Worker 6616 changing state from 'startup' to 'active'][]
[Pool-TestPool][debug][5][Current worker states][{"active":2}]
```

And here is what the log looks like for shutdown:

```
[PoolManager][debug][3][Worker Pool Manager shutting down][]
[Pool-TestPool][debug][2][Shutting down pool: TestPool][]
[Pool-TestPool][debug][4][Worker 6334 shutting down (0 requests served)][]
[Pool-TestPool][debug][6][Sending 'shutdown' command to process: 6334][]
[Pool-TestPool][debug][5][Worker 6334 changing state from 'active' to 'shutdown'][]
[Pool-TestPool][debug][5][Current worker states][{"shutdown":1,"active":1}]
[Pool-TestPool][debug][4][Worker 6335 shutting down (1 requests served)][]
[Pool-TestPool][debug][6][Sending 'shutdown' command to process: 6335][]
[Pool-TestPool][debug][5][Worker 6335 changing state from 'active' to 'shutdown'][]
[Pool-TestPool][debug][5][Current worker states][{"shutdown":2}]
[Pool-TestPool][debug][4][Child 6334 exited with code: 0][]
[Pool-TestPool][debug][4][Worker 6334 has been removed from the pool][]
[Pool-TestPool][debug][5][Current worker states][{"shutdown":1}]
[Pool-TestPool][debug][4][Child 6335 exited with code: 0][]
[Pool-TestPool][debug][4][Worker 6335 has been removed from the pool][]
[Pool-TestPool][debug][2][All workers exited, pool shutdown complete][]
```

Here is an example of an error (in this case an [HTTP 500](#http-500-internal-server-error)):

```
[Pool-TestPool][error][500][Error: Test Error Message][{"request_id":"rj5hr4brm01","worker":6697}]
```

If you have [http_log_requests](https://www.npmjs.com/package/pixl-server-web#http_log_requests) enabled in your [pixl-server-web](https://www.npmjs.com/package/pixl-server-web) configuration, all HTTP errors are also logged as transactions:

```
[WebServer][transaction][HTTP 500 Internal Server Error][/pool?error=1][{"proto":"http","ips":["::ffff:127.0.0.1"],"host":"127.0.0.1:3012","ua":"curl/7.54.0","perf":{"scale":1000,"perf":{"total":12.017,"read":0.37,"process":5.741,"worker":3.837,"write":4.419},"counters":{"bytes_in":90,"bytes_out":104,"num_requests":1}}}]
```

# License

The MIT License (MIT)

Copyright (c) 2017 Joseph Huckaby.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
