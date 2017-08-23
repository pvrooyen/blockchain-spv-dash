'use strict';

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

var EventEmitter = require('events').EventEmitter;
var async = require('async');
var u = require('dash-util');
var DefaultBlock = require('bitcore-lib-dash').BlockHeader;
var from = require('from2').obj;
var to = require('flush-write-stream').obj;
var inherits = require('inherits');
var BlockStore = require('./blockStore.js');
var HeaderStream = require('./headerStream.js');
if (!setImmediate) require('setimmediate');

var storeClosedError = new Error('Store is closed');

function validParameters(params) {
  return _typeof(params.genesisHeader) === 'object' && typeof params.shouldRetarget === 'function' && typeof params.calculateTarget === 'function' && typeof params.miningHash === 'function';
}

var Blockchain = module.exports = function (params, db, opts) {
  if (!(this instanceof Blockchain)) return new Blockchain(params, db, opts);
  if (!params || !validParameters(params)) {
    throw new Error('Invalid blockchain parameters');
  }
  if (!db) throw new Error('Must specify db');
  this.params = params;
  opts = opts || {};

  var Block = params.Block || DefaultBlock;

  function blockFromObject(obj) {
    return new Block(obj);
  }

  var genesisHeader = blockFromObject(params.genesisHeader);
  this.genesis = this.tip = {
    height: 0,
    hash: genesisHeader._getHash(),
    header: genesisHeader
  };

  if (params.checkpoints && !opts.ignoreCheckpoints) {
    var lastCheckpoint = params.checkpoints[params.checkpoints.length - 1];
    this.checkpoint = {
      height: lastCheckpoint.height,
      header: blockFromObject(lastCheckpoint.header)
    };
    this.checkpoint.hash = this.checkpoint.header._getHash();
    this.tip = this.checkpoint;
  }

  this.ready = false;
  this.closed = false;
  this.adding = false;

  var indexInterval = params.interval;
  this.store = new BlockStore({ db: db, Block: Block, indexInterval: indexInterval });
  this._initialize();
};
inherits(Blockchain, EventEmitter);

Blockchain.prototype._initialize = function () {
  var _this = this;

  if (this.ready) {
    return this._error(new Error('Already initialized'));
  }

  this._initStore(function (err) {
    if (err) return _this._error(err);
    _this.store.getTip(function (err, tip) {
      if (err && err.name !== 'NotFoundError') return _this._error(err);
      if (tip) _this.tip = tip;
      _this.ready = true;
      _this.emit('ready');
    });
  });
};

Blockchain.prototype._initStore = function (cb) {
  var _this2 = this;

  var putIfNotFound = function putIfNotFound(block) {
    return function (cb) {
      _this2.store.get(block.hash, function (err, found) {
        if (err && !err.notFound) return cb(err);
        if (found) return cb(); // skip if already stored
        if (_this2.closed || _this2.store.isClosed()) return cb(storeClosedError);
        _this2.store.put(block, { commit: true, best: true }, cb);
      });
    };
  };

  var tasks = [putIfNotFound(this.genesis)];
  if (this.checkpoint) tasks.push(putIfNotFound(this.checkpoint));
  async.parallel(tasks, cb);
};

Blockchain.prototype.onceReady = function (cb) {
  if (this.ready) return cb();
  this.once('ready', cb);
};

Blockchain.prototype.close = function (cb) {
  var _this3 = this;

  this.onceReady(function () {
    _this3.closed = true;
    _this3.store.close(cb);
  });
};

Blockchain.prototype.getTip = function () {
  return this.tip;
};

Blockchain.prototype.getPath = function (from, to, cb) {
  var _this4 = this;

  var output = {
    add: [],
    remove: [],
    fork: null
  };

  var top, bottom, down;
  if (from.height > to.height) {
    top = from;
    bottom = to;
    down = true;
  } else {
    top = to;
    bottom = from;
    down = false;
  }

  var addTraversedBlock = function addTraversedBlock(block) {
    if (down && block.header.getHash().compare(to.header.getHash()) !== 0) {
      output.remove.push(block);
    } else if (!down && block.header.getHash().compare(from.header.getHash()) !== 0) {
      output.add.unshift(block);
    }
  };

  // traverse down from the higher block to the lower block
  var traverseDown = function traverseDown(err, block) {
    if (err) return cb(err);
    if (block.height === bottom.height) {
      // we traversed down to the lower height
      if (block.header.getHash().compare(bottom.header.getHash()) === 0) {
        // the blocks are the same, there was no fork
        addTraversedBlock(block);
        return cb(null, output);
      }
      // the blocks are not the same, so we need to traverse down to find a fork
      return traverseToFork(block, bottom);
    }
    addTraversedBlock(block);
    _this4.getBlock(block.header.prevHash, traverseDown);
  };

  // traverse down from both blocks until we find one block that is the same
  var traverseToFork = function traverseToFork(left, right) {
    if (left.height === 0 || right.height === 0) {
      // we got all the way to two different genesis blocks,
      // the blocks don't have a path between them
      return cb(new Error('Blocks are not in the same chain'));
    }

    output.remove.push(down ? left : right);
    output.add.unshift(down ? right : left);

    _this4.getBlock(left.header.prevHash, function (err, left) {
      if (err) return cb(err);
      _this4.getBlock(right.header.prevHash, function (err, right) {
        if (err) return cb(err);
        if (left.header.getHash().compare(right.header.getHash()) === 0) {
          output.fork = left;
          return cb(null, output);
        }
        traverseToFork(left, right);
      });
    });
  };
  traverseDown(null, top);
};

Blockchain.prototype.getPathToTip = function (from, cb) {
  this.getPath(from, this.tip, cb);
};

Blockchain.prototype.getBlock = function (hash, cb) {
  var _this5 = this;

  if (!Buffer.isBuffer(hash)) {
    return cb(new Error('"hash" must be a Buffer'));
  }
  this.onceReady(function () {
    return _this5.store.get(hash, cb);
  });
};

Blockchain.prototype.getBlockAtTime = function (time, cb) {
  var _this6 = this;

  var output = this.tip;
  var traverse = function traverse(err, block) {
    if (err) return cb(err);
    if (block.header.time <= time) return cb(null, output);
    if (block.header.time >= time) output = block;
    if (block.height === 0) return cb(null, output);
    _this6.getBlock(block.header.prevHash, traverse);
  };
  traverse(null, this.tip);
};

Blockchain.prototype.getBlockAtHeight = function (height, cb) {
  var _this7 = this;

  if (height > this.tip.height) {
    var err = new Error('height is higher than tip');
    err.notFound = true;
    return cb(err);
  }
  if (height < 0) return cb(new Error('height must be >= 0'));

  this.store.getIndex(height, function (err, indexHash) {
    if (err) return cb(err);

    var traverse = function traverse(err, block) {
      if (err) return cb(err);
      if (block.height === height) return cb(null, block);
      _this7.getBlock(block.next, traverse);
    };
    _this7.getBlock(indexHash, traverse);
  });
};

Blockchain.prototype.getLocator = function (from, cb) {
  var _this8 = this;

  if (typeof from === 'function') {
    cb = from;
    from = this.tip.hash;
  }
  var locator = [];
  var getBlock = function getBlock(from) {
    _this8.getBlock(from, function (err, block) {
      if (err && err.notFound) return cb(null, locator);
      if (err) return cb(err);
      locator.push(block.header.getHash());
      if (locator.length < 6 || !block.height === 0) {
        return getBlock(block.header.prevHash);
      }
      cb(null, locator);
    });
  };
  getBlock(from);
};

Blockchain.prototype._error = function (err) {
  if (!err) return;
  this.emit('error', err);
};

Blockchain.prototype._put = function (hash, opts, cb) {
  var _this9 = this;

  this.onceReady(function () {
    return _this9.store.put(hash, opts, cb);
  });
};

Blockchain.prototype.createWriteStream = function () {
  var _this10 = this;

  return to({ highWaterMark: 4 }, function (headers, enc, cb) {
    _this10.addHeaders(headers, cb);
  });
};

Blockchain.prototype.createReadStream = function (opts) {
  return new HeaderStream(this, opts);
};

Blockchain.prototype.createLocatorStream = function (opts) {
  var _this11 = this;

  var changed = true;
  var getting = false;
  var pushLocator = function pushLocator(cb) {
    changed = false;
    _this11.getLocator(function (err, locator) {
      if (err) return cb(err);
      getting = false;
      cb(null, locator);
    });
  };
  this.on('consumed', function () {
    changed = true;
  });
  return from(function (size, next) {
    if (getting) return;
    getting = true;
    if (changed) return pushLocator(next);
    _this11.once('consumed', function () {
      return pushLocator(next);
    });
  });
};

Blockchain.prototype.addHeaders = function (headers, cb) {
  var _this12 = this;

  if (this.adding) return cb(new Error('Already adding headers'));

  var previousTip = this.tip;
  this.adding = true;
  var done = function done(err, last) {
    _this12.emit('consumed');
    if (err) _this12.emit('headerError', err);else _this12.emit('headers', headers);
    _this12.adding = false;
    _this12.store.commit(function (err2) {
      if (err || err2) return cb(err || err2);
      _this12.emit('commit', headers);
      cb(null, last);
    });
  };

  this.getBlock(headers[0].prevHash, function (err, start) {
    if (err && err.notFound) {
      return done(new Error('Block does not connect to chain'));
    }
    if (err) return done(err);
    start.hash = start.header.getHash();

    async.reduce(headers, start, _this12._addHeader.bind(_this12), function (err, last) {
      if (err) return done(err, last);

      // TODO: add even if it doesn't pass the current tip
      // (makes us store orphan forks, and lets us handle reorgs > 2000 blocks)

      if (last.height > previousTip.height) {
        _this12.getPath(previousTip, last, function (err, path) {
          if (err) return done(err, last);
          if (path.remove.length > 0) {
            _this12._reorg(path, done);
            return;
          }
          done(null, last);
        });
        return;
      }

      done(null, last);
    });
  });
};

Blockchain.prototype._reorg = function (path, cb) {
  var _this13 = this;

  // wait for db to finish committing if neccessary
  if (this.store.committing) {
    this.store.once('commit', function () {
      return _this13._reorg(path, cb);
    });
    return;
  }

  // create new db transaction if there isn't one
  if (!this.store.tx) this.store.createTx(false);

  // iterate through the new best fork, and put the blocks again
  // (this updates the links, height index, and tip)
  var put = function put(prev) {
    var i = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 0;

    if (i === path.add.length) {
      _this13.emit('reorg', { path: path, tip: prev });
      return cb(null, prev);
    }
    var block = path.add[i];
    _this13.store.put(block, {
      best: true,
      tip: i === path.add.length - 1,
      prev: prev
    }, function (err) {
      if (err) return cb(err);
      put(block, i + 1);
    });
  };
  put(path.fork);
};

Blockchain.prototype._addHeader = function (prev, header, cb) {
  var _this14 = this;

  var height = prev.height + 1;
  var block = {
    height: height,
    hash: header._getHash(),
    header: header
    // if prev already has a "next" pointer, then this is a fork, so we
    // won't change it to point to this block (yet)
  };var link = !prev.next;

  var put = function put() {
    var tip = height > _this14.tip.height;
    _this14._put({ header: header, height: height }, { tip: tip, prev: prev, link: link }, function (err) {
      if (err) return cb(err);
      _this14.emit('block', block);
      _this14.emit('block:' + block.hash.toString('base64'), block);
      if (tip) {
        _this14.tip = block;
        _this14.emit('tip', block);
      }
      cb(null, block);
    });
  };

  if (header.prevHash.compare(prev.hash) !== 0) {
    return cb(new Error('Block does not connect to previous'), block);
  }
  this.params.shouldRetarget(block, function (err, retarget) {
    if (err) return cb(err);
    if (!retarget && header.bits !== prev.header.bits) {

      // TODO
      // return cb(new Error('Unexpected difficulty change at height ' + height), block)

    }
    _this14.validProof(header, function (err, validProof) {
      if (err) return cb(err);
      if (!validProof) {}

      // TODO
      /*
      return cb(new Error('Mining hash is above target. ' +
        'Hash: ' + header.getId() + ', ' +
        'Target: ' + u.expandTarget(header.bits).toString('hex') + ')'), block)
      */

      // TODO: other checks (timestamp, version)
      /*
      if (retarget) {
        return this.params.calculateTarget(block, this, (err, target) => {
          if (err) return cb(err, block)
           var expected = u.compressTarget(target)
          if (expected !== header.bits) {
            return cb(new Error('Bits in block (' + header.bits.toString(16) + ')' +
              ' different than expected (' + expected.toString(16) + ')'), block)
          }
          put()
        })
      }
      */

      put();
    });
  });
};

Blockchain.prototype.validProof = function (header, cb) {
  this.params.miningHash(header, function (err, hash) {
    if (err) return cb(err);
    var target = u.expandTarget(header.bits);
    cb(null, hash.compare(target) !== 1);
  });
};

Blockchain.prototype.maxTarget = function () {
  return u.expandTarget(this.params.genesisHeader.bits);
};

Blockchain.prototype.estimatedChainHeight = function () {
  var elapsed = Date.now() / 1000 - this.tip.header.time;
  var blocks = Math.round(elapsed / this.params.targetSpacing);
  return this.tip.height + blocks;
};