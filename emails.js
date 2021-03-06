// Write your package code here!

Emails = {};

Emails.config = {
	// boolean - whether or not to place the messages in a queue before sending them
	queue: false
	// boolean - whether or not to leave/insert messages in the emails collection after sending them
	// if false will delete messages which have been sent
	// if true will upsert messages which have been sent
	, persist: true
	// boolean - whether to observe the emails collection and automatically process/send
	// emails as they are added.
	// also causes the queue to be processed on startup.
	, autoprocess: false
	, collectionName: 'emails'
};

Emails.initialize = function (config) {
	// allow lazy initialization.
	if (!config && Emails._collection) return;

	// override defaults with specified config
	_.extend(Emails.config, config);

	// initialize emails collection
	if (!Emails._collection) {
		Emails._collection = new Mongo.Collection(Emails.config.collectionName);

		// this index prevents seperate servers from both forwarding the same message
		Emails._collection._ensureIndex({"incomingId" : 1}, {sparse: true, unique: true});
		Emails._collection._ensureIndex({"outgoingId" : 1}, {sparse: true, unique: true});
	}

	if (Emails._observer) Emails._observer.stop();

	// initialize auto-process code
	if (Emails.config.autoprocess) {
		Emails._observer = Emails._collection.find({
			sent: {
				$exists: false
			}
			, draft: {
				$exists: false
			}
		}).observe({
			added: Emails.deliver
			, changed: Emails.deliver
		});
	}
};

Emails.send = function (email) {
	// preprocesses a message and then either queues or immediately sends it
	// depending on the queue config option.

	Emails.initialize();

	try {

		email = Emails.process(email);

		if (Emails.config.queue) {
			return Emails.enqueue(email);
		} else {
			return Emails.deliver(email);
		}
	} catch (e) {
		if (e instanceof Meteor.Error) throw e;
		else Emails.reject(email, e.message);
	}
};

Emails.process = function (email) {
	// pre-processes an email for enquement or delivery

	// create the cache or context object.
	var cache = {};

	// dont polute the object we were passed.
	email = _.clone(email);

	// don't process drafts.
	if (!email.draft) {

		Emails.getMetadata(email, cache);

		// populate user ids
		if (!email.fromId) email.fromId = Emails.getFromId(email, cache);
		if (!email.toId) email.toId = Emails.getToId(email, cache);

		if (!email.fromId) Emails.reject(email, 'missing sender');
		if (!email.toId) Emails.reject(email, 'missing recipient');

		// populate to and from email addresses
		email.from = Emails.getFromAddress(email.fromId, email, cache);
		email.to = Emails.getToAddress(email.toId, email, cache);
		email.replyTo = Emails.getReplyTo(email.fromId, email, cache);

		if (!email.from) Emails.reject(email, 'missing from address');
		if (!email.to) Emails.reject(email, 'missing to address');
		if (!email.replyTo) delete email.replyTo;

		if (!email.layoutTemplate && !_.isNull(email.layoutTemplate)) {
			email.layoutTemplate = Emails.config.layoutTemplate;
		}

		if (!email.template) {
			email.template = Emails.config.defaultTemplate;
		}

		// populate threadId and message body
		if (!email.threadId) email.threadId = Emails.getThreadId(email, cache);
		if (!email.text) email.text = Emails.getText(email, cache);
		if (!email.html) email.html = Emails.getHtml(email, cache);

		if (!email.subject) Emails.reject(email, 'missing message subject');
		if (!email.text && !email.html) Emails.reject(email, 'missing message body');

		if (!email.text) delete email.text;
		if (!email.html) delete email.html;

		// allow developer to specify any final transformations
		Emails.preProcess(email, cache);		
	}

	if (!email._id) email.createdAt = new Date();
	else email.updatedAt = new Date();

	return email;
};

Emails.enqueue = function (email) {
	// inserts an email into the queue

	// handle drafts
	if (email.draft === false) {
		if (!email._id) throw new Error('No id passed when sending draft email.');

		// replace the document in it's entirety
		// we don't preprocess drafts so we don't know if the fields which 
		// wouldn't be overwritten are valid.

		var modifier = _.clone(email);
		delete modifier.draft;
		delete modifier._id;
		
		Emails._collection.update(email._id, modifier);
	} else {
		return Emails._collection.insert(email);
	}

	
};

Emails.reject = function (email, message) {
	email.rejectionMessage = message || 'unknown error';
	if (email.incomingId && typeof Emails.provider.reject == 'function') {
		Emails.provider.reject(email);
	}
	if (email._id) {
		// this email is in the db
		if (Emails.config.persist) {
			// we want to keep a record of this email
			// don't mark it as a draft, it was 'sent'
			// mark it as 'send failed'
			Emails._collection.update(email._id, {
				$set: {
					sent: false
					// we want both these fields to be logged so we can back
					// track what caused the failure.
					, rejectionMessage: email.rejectionMessage
					, rejectedEmail: email
				}
				, $unset: {
					draft: true
				}
			});
		} else {
			Emails._collection.remove(email._id);
		}
	}
	throw new Meteor.Error(400, message, email);
};

Emails.deliver = function (email) {
	// actually sends an email

	// handle drafts
	if (email.draft) throw new Error('Email is marked as draft.');

	if (email._id) {
		var marker = Random.id();
		Emails._collection.update({
			_id: email._id
			, sent: {
				$exists: false
			}
		}, {
			$set: {
				sent: marker
			}
		});
		email = Emails._collection.findOne({
			sent: marker
		});
		if (!email) {
			return null;
		}
	}
	
	var updates = {
		sent: true
		, sentAt: new Date()
	};

	// XXX use _.pick to whitelist fields to pass to email.send
	Emails.provider.send(email, updates);

	if (email._id) {
		if (Emails.config.persist) {
			Emails._collection.update(email._id, {
				$set: updates
			});
		} else {
			Emails._collection.remove(email._id);
		}
	}

	return email._id;
};

Emails.receive = function (email) {
	if (!email.incomingId) {
		throw new Error('Receiving emails must have an incomingId');
	}
	// this check is no longer necessary, we have added this check as a unique
	// index on the db, and also expect Emails.provider to implement this check
	// as well:
		// if ((Emails.config.persist || Emails.config.queue) &&
		// 	Emails._collection &&
		// 	Emails._collection.findOne({
		// 		incomingId: email.incomingId
		// 	})) {
		// 	throw new Error('Email has already been processed');
		// }
	email = _.extend({
		original: email
		, receivedAt: new Date()
	}, email);
	Emails.send(email);
};

// unused code

	// Emails.lastReceived = function () {
	// 	return Emails._collection && Emails._collection.findOne({
	// 		incomingId: {
	// 			$exists: true
	// 		}
	// 	}, {
	// 		sort: {
	// 			receivedAt: -1
	// 		}
	// 	});
	// };

	// Emails.lastReceivedDate = function () {
	// 	var email = Emails.lastReceived();
	// 	return email && email.receivedAt;
	// };

// Preprocessor helpers
// should be in the format function (arg, email)

Emails.getUser = function (emailAddress, email, cache) {
	if (typeof emailAddress != 'string') return;
	// returns a userId by processing an email address.
	var query = {
		"emails.address": emailAddress
	};
	if (emailAddress.indexOf('@' + Emails.config.domain) != -1) {
		var username = emailAddress.slice(0, emailAddress.indexOf('@'));
		var userId = _.last(username.split('_'));
		query = {
			$or: [
				query
				, {
					_id: userId
				}
			]
		};
	}
	return Meteor.users.findOne(query);
};

Emails.getFromAddress = function (userId, email, cache) {
	return 'user_' + userId + '@' + Emails.config.domain;
};

Emails.getToAddress = function (userId, email, cache) {
	cache.toUser = cache.toUser || Meteor.users.findOne(userId);
	return (cache.toUser && cache.toUser.emails && cache.toUser.emails[0] || {}).address;
};

Emails.getPrettyAddress = function (address, name, email, cache) {
	if (_.isString(name)) {
		return '"' + name.replace(/[^a-z0-9!#$%&'*+\-\/=?\^_`{|}~ ]/ig, "") + '" <' + address + '>';
	} else {
		return address;
	}
};

Emails.prettifyAddresses = function (email, cache) {
	if (Emails.config.defaultFromAddress && email.replyTo) {
		email.from = Emails.config.defaultFromAddress;
	} else if (cache.fromUser && cache.fromUser.profile && cache.fromUser.profile.name) {
		email.from = Emails.getPrettyAddress(email.from, cache.fromUser.profile.name);
	}
	if (cache.toUser && cache.toUser.profile && cache.toUser.profile.name) {
		email.to = Emails.getPrettyAddress(email.to, cache.toUser.profile.name);
	}
};

// Pre-processers
// these processors are run in the order listed
// should be in the format: function (email, cache) where
// email is the email object to be stored/sent
// cache is an object which passes/returns metadata we don't need to
//       store on the email record, for example {fromUser: Users.findOne(fromId)}

// getMetadata and preProcess should be app defined and will always be run,
// each of the other functions will be run only if the corrosponding property is missing

Emails.getMetadata = function (email, cache) {
	// sets any app defined properties which should be stored on the email record
	// and available to other preprocessors
	cache.fromUser = email.fromId && Meteor.users.findOne(email.fromId);
	cache.toUser = email.toId && Meteor.users.findOne(email.toId);
};

Emails.getFromId = function (email, cache) {
	// sets the fromId of an email
	var user = Emails.getUser(email.from, email, cache);
	if (user) {
		cache.fromUser = user;
		return user._id;
	} else {
		return null;
	}
};

Emails.getToId = function (email, cache) {
	// sets the toId of an email
	var user = Emails.getUser(email.to, email, cache);
	if (user) {
		cache.toUser = user;
		return user._id;
	} else {
		return null;
	}
};

Emails.getReplyTo = function (fromId, email, cache) {
	// sets the replyTo of an outgoing email
	return Emails.getFromAddress(fromId, email, cache);
};

Emails.getThreadId = function(email, cache) {
	return [email.fromId, email.toId].sort().join("_");
};

Emails.getText = function (email, cache) {
	// sets the plain text email copy
	return null;
};

Emails.getHtml = function (email, cache) {
	// sets the html email copy
	var template = email.template && Template[email.template];
	if (template) {
		var data  = _.extend({}, email, cache);
		var layoutTemplate = email.layoutTemplate && Template[email.layoutTemplate];
		if (layoutTemplate) {
			layoutTemplate.helpers({
				yield: function () {
					return template;
				}
			});
			return Blaze.toHTMLWithData(layoutTemplate, data);
		} else {
			return Blaze.toHTMLWithData(template, data);
		}
	} else {
		return (email.text || '').split('\n').join('<br>\n');
	}
};

Emails.preProcess = function (email, cache) {
	// user defined method to do any processing of the email which needs to happen after the email
	// processing logic is finished.
	Emails.prettifyAddresses(email, cache);
};

/*
	Sample Email:
	{
		// These fields used by the Email.send method:

		from: 'somebody@gmail.com'
		, to: 'somebodyelse@gmail.com'
		// also allowed:
		// , cc, bcc, replyTo
		, subject: 'hi there'
		, text: 'hows it going'
		, html: '<p>hows it going</p>'
		// XXX disallow this?
		// override it in Emails.config?
		, headers: {}

		// These fields are used by the email processing system to store
		// state information:
		
		// sent
		, sent: true // this email has been processed and sent
		, sent: false // this email has been processed, but was not sent
		, sent: 'somelongrandomid' // this email is being processed
		, sent: {$exists: false} // this email has not been processed

		// draft
		, draft: true // this email should not be processed yet

		// read
		, read: true // the recipient of this email has read the email

		// These fields are used by the email processing system to store
		// metadata:

		, threadId: 'somerandomid'
		, fromId: 'someuserid'
		, toId: 'someotheruserid'
		, original: '{}' // reserved for logging the 'raw' email
		, error: '{}' // reserved for logging errors related to this email
	}
*/
