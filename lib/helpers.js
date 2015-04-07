var request = require('request'),
    mongoose = require('mongoose'),
    ObjectId = mongoose.Types.ObjectId,
    util = require('util'),
    url = require('url')

/**
 * Sends an http request using `reqOpts`, calls `cb` upon completion.
 * Upon ECONNRESET, backs off linearly in increments of 500ms with some noise to reduce concurrency.
 *
 * @param  {Object}   reqOpts   request options object
 * @param  {Function} cb        Signature: function (err, res, body)
 */
exports.backOffRequest = function (reqOpts, cb) {
    var maxAttempts = 3
    var backOffRate = 500

    function makeAttempts (attempts) {
        attempts++

        request(reqOpts, function (err, res, body) {
            if (err) {
                if (
                    (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ETIMEDOUT')
                 && attempts <= maxAttempts
                 ) {
                    var waitTime = backOffRate*attempts+Math.random()*backOffRate

                    setTimeout(function () {
                        makeAttempts(attempts)
                    }, waitTime)
                    return
                } else {
                    var error = new Error('elasticsearch request error: '+err)
                    error.details = err
                    error.attempts = attempts
                    error.reqOpts = reqOpts

                    return cb(error)
                }
            }

            // parse the response body as JSON
            try {
                var parsedBody = JSON.parse(body)
            } catch (parseErr) {
                var error = new Error('Elasticsearch did not send back a valid JSON reply: '+util.inspect(body, true, 10, true))
                error.elasticsearchReply = body
                error.reqOpts = reqOpts
                error.details = parseErr

                return cb(error)
            }

            // success case
            return cb(err, res, parsedBody)
        })
    }

    makeAttempts(0)
}

/**
 * Performs deep-traversal on `thing` and converts
 * any object ids to hex strings, and dates to ISO strings.
 *
 * @param  {Any type} thing
 */
exports.serialize = function (thing) {
    if (Array.isArray(thing)) {
        return thing.map(exports.serialize)
    } else if (thing instanceof ObjectId) {
        return thing.toString()
        //return thing.toHexString()
    } else if (thing instanceof Date) {
        return thing.toISOString()
    } else if (typeof thing === 'object' && thing !== null) {
        Object
        .keys(thing)
        .forEach(function (key) {
            thing[key] = exports.serialize(thing[key])
        })
        return thing
    } else {
        //return JSON.stringify(thing)
        return thing
    }
}

/**
 * Flattens sub documents in thing
 *
 * @param  {Any type} thing
 */
exports.flatten = function(thing, sufix) {
    var result = {};
    function recurse (cur, prop) {
        //if (Object(cur) !== cur) {
            prop = prop + sufix;
            result[prop] = cur;
        // } else if (Array.isArray(cur)) {
        //      for(var i=0, l=cur.length; i<l; i++)
        //          recurse(cur[i], prop + "[" + i + "]");
        //     if (l == 0)
        //         result[prop] = [];
        // } else {
        //     var isEmpty = true;
        //     for (var p in cur) {
        //         isEmpty = false;
        //         recurse(cur[p], prop ? prop+"."+p : p);
        //     }
        //     if (isEmpty && prop)
        //         result[prop] = {};
        // }
    }
    recurse(thing, "");
    return result;
}

/**
 * Serialize a mongoose model instance for elasticsearch.
 *
 * @param  {Mongoose model instance} model
 * @return {Object}
 */
exports.serializeModel = function (model,options) {
    // strip mongoose-added functions, and depopulate any populated model references
    var deflated = model.toObject({ depopulate: true })
    var serialized = exports.serialize(deflated)
    if(options.flatten && options.grouper){
        serialized[options.flatten] = exports.flatten(serialized[options.flatten], serialized[options.grouper])
    }
    return serialized
}

/**
 * Merge user-supplied `options` object with defaults (to configure Elasticsearch url)
 * @param  {Object} options
 * @return {Object}
 */
exports.mergeOptions = function (options) {
    // default options
    var defaultOptions = {
        protocol: 'http',
        host: 'localhost',
        port: null,
        prefix: ''
    }

    if (!options) {
        return defaultOptions
    }

    // if user specifies an `options` value, ensure it's an object
    if (typeof options !== 'object') {
        throw new Error('elmongo options was specified, but is not an object. Got:'+util.inspect(options, true, 10, true))
    }

    var mergedOptions = {}

    if (options.url) {
        // node's url module doesn't parse imperfectly formed URLs sanely.
        // use a regex so the user can pass in urls flexibly.

        // Rules:
        // url must specify at least host and port (protocol falls back to options.protocol or defaults to http)
        // if `host`, `port` or `protocol` specified in `options` are different than those in url, throw.
        var rgxUrl = /^((http|https):\/\/)?(.+):([0-9]+)/
        var urlMatch = rgxUrl.exec(options.url)

        if (!urlMatch) {
            throw new Error('url from `options` must contain host and port. url: `'+options.url+'`.')
        }

        // if no protocol in url, default to options protocol, or http
        var protocol = urlMatch[2];
        if (protocol && options.protocol && protocol !== options.protocol) {
            // user passes in `protocol` and a different protocol in `url`.
            throw new Error('url specifies different protocol than protocol specified in `options`. Pick one to use in `options`.')
        }
        mergedOptions.protocol = protocol || options.protocol || defaultOptions.protocol

        var hostname = urlMatch[3];
        if (!hostname) {
            // hostname must be parseable from the url
            throw new Error('url from `options` must contain host and port. url: `'+options.url+'`.')
        }
        mergedOptions.host = hostname

        var port = urlMatch[4];
        if (!port) {
            // port must be specified in url
            throw new Error('url from `options` must contain host and port. url: `'+options.url+'`.')
        }

        if (port && options.port && port !== options.port) {
            // if port is specified in `options` too, and its a different value, throw.
            throw new Error('url specifies different port than port specified in `options`. Pick one to use in `options`.')
        }
        mergedOptions.port = port

        mergedOptions.prefix = typeof options.prefix === 'string' ? options.prefix : ''
    } else {
        Object.keys(defaultOptions).forEach(function (key) {
            mergedOptions[key] = options[key] || defaultOptions[key]
        })
    }
    mergedOptions.grouper = options.grouper
    mergedOptions.flatten = options.flatten

    return mergedOptions
}

/**
 * Merge the default elmongo collection options with the user-supplied options object
 *
 * @param  {Object} options (optional)
 * @param  {Object}
 * @return {Object}
 */
exports.mergeModelOptions = function (options, model) {
    var mergedOptions = exports.mergeOptions(options)

    // use lower-case model name as elasticsearch type
    mergedOptions.type = model.collection.name.toLowerCase()

    return mergedOptions
}

/**
 * Merge the default elmongo search options with the user-supplied `searchOpts`
 * @param  {Object} searchOpts
 * @return {Object}
 */
exports.mergeSearchOptions = function (searchOpts) {

    var defaultSearchOpts = {
        query: '*',
        fields: [ '_all' ],
        fuzziness: 0.0,
        where: {},
        range: null,
        pageSize: 25,
        multiValueSearchTerms: null,
        aggregationTerms: null,
        page: 1
    }

    var mergedSearchOpts = {}

    // merge the user's `options` object with `defaultOptions`
    Object
    .keys(defaultSearchOpts)
    .forEach(function (key) {
        mergedSearchOpts[key] = searchOpts[key] || defaultSearchOpts[key]
    })

    return mergedSearchOpts
}

/**
 * Generate a search request body from `searchOpts`.
 *
 * @param  {Object} searchOpts
 * @return {Object}
 */
exports.mergeSearchBody = function (searchOpts) {
    // console.log('\nmergeSearchBody searchOpts', util.inspect(searchOpts, true, 10, true))


    var body = {
            "query" : {
                "filtered" : {
                    "query": { 
                        bool: {
                            should: [
                                // exact match query with high boost so that exact matches are always returned and scored higher
                                {
                                    multi_match: {
                                        query: searchOpts.query,
                                        fields: searchOpts.fields,
                                        // if analyzer causes zero terms to be produced from the query, return all results
                                        zero_terms_query: 'all',
                                        boost: 3
                                    }
                                },
                                // fuzzy query with lower boost than exact match query
                                {
                                    multi_match: {
                                        query: searchOpts.query,
                                        fields: searchOpts.fields,
                                        // if analyzer causes zero terms to be produced from the query, return all results
                                        zero_terms_query: 'all',
                                        fuzziness: searchOpts.fuzziness,
                                        boost: 1
                                    }
                                }
                            ],
                            minimum_should_match: 1
                        }
                    },
                    // sort: [
                    //     { '_score': 'desc' }
                    // ],
                    
                }
            },
            
          
        }

    //if aggregation terms were entered add the aggregation
    if(searchOpts.terms){
        body.aggs = {
                "my_agg": {
                    "terms": searchOpts.terms
                }
            }      
        }

    //if a valid range was entered add the range filter
    // if(searchOpts.range && searchOpts.range != null && searchOpts.range.length > 0){
    //     console.log("searchopts.range: ", searchOpts.range);
    //     if(!body.query.filtered.filter){
    //         body.query.filtered.filter = {};
    //     }

    //     body.query.filtered.filter.range = searchOpts.range[0].range
    // }

    if(searchOpts.multiValueSearchTerms){
        body.query.filtered.filter = {
            "terms" : {"_id": searchOpts.multiValueSearchTerms}
        }
    }

    body.from = searchOpts.page ? (searchOpts.page - 1) * searchOpts.pageSize : 0
    body.size = searchOpts.pageSize

    if (searchOpts.where && Object.keys(searchOpts.where).length) {
        var mustFilters = []
        var shouldFilters = []

        var whereClauseKeys = Object.keys(searchOpts.where)

        // generate filters for search body (by default use `and`, unless `or` is specified)
        whereClauseKeys.forEach(function (whereClauseKey) {
            var whereClauseValue = searchOpts.where[whereClauseKey];

            // console.log('whereClauseKey', whereClauseKey)
            // console.log('whereClauseValue', whereClauseValue)

            if (whereClauseKey === 'or') {
                // an `or` clause is converted to a `should` clause (at least one `should` clause must match)
                var orClauseKeys = Object.keys(searchOpts.where[whereClauseKey])
                orClauseKeys.forEach(function (orClauseKey) {
                    var orClauseValue = searchOpts.where[whereClauseKey][orClauseKey];
                    if (typeof orClauseValue === 'string') {
                        orClauseValue = orClauseValue.toLowerCase()
                    }

                    var termFilter = {
                        term: { }
                    }

                    termFilter.term[orClauseKey] = orClauseValue

                    shouldFilters.push(termFilter)
                })
            } else {
                if (Array.isArray(whereClauseValue)) {
                    // where clause is an array, treat as an $in query

                } else if (typeof whereClauseValue === 'object') {
                    // where clause is an object - has the format $operator: value
                } else {
                    // where clause is a primitive value - add a `term` query to filters

                    // if it's a string value, lowercase it since we index with `lowercase` filter
                    if (typeof whereClauseValue === 'string') {
                        whereClauseValue = whereClauseValue.toLowerCase()
                    }

                    var termFilter = {
                        term: { }
                    }

                    termFilter.term[whereClauseKey] = whereClauseValue

                    mustFilters.push(termFilter)
                }
            }
        })

        //if a valid agg was entered add the filter to the query
        if(searchOpts.terms){
            //if a filter wasn't already created by the range searchOpt create it. 
            if(!body.query.filtered.filter){
                body.query.filtered.filter = {};
            }
            body.query.filtered.filter.and = mustFilters
        } else{
            //If no agg terms specified, add a normal filter (post filter)
            body.filter = {
                bool : {
                    must : [],
                    should : []
                }
            }

            if (mustFilters.length) {
                // generate `must` filters in bool query (if user supplied any)
                body.filter.bool.must = mustFilters
            }
            if (shouldFilters.length) {
                // generate `should` filters in bool query (if user supplied any)
                body.filter.bool.should = shouldFilters
            }
        }
    } 

    //TODO: merge this w/ logic above for creating term filters
    if (searchOpts.range && Object.keys(searchOpts.range).length) {
    //if (searchOpts.range && searchOpts.range.length) {

        var rangeClauseKeys = Object.keys(searchOpts.range)
        //console.log("rangeClauseKeys", rangeClauseKeys)

        // generate filters for search body (by default use `and`, unless `or` is specified)
        rangeClauseKeys.forEach(function (rangeClauseKey) {
            var rangeClauseValue = searchOpts.range[rangeClauseKey];

            // console.log('whereClauseKey', whereClauseKey)
            // console.log('whereClauseValue', whereClauseValue)

            if (rangeClauseKey === 'or') {
                //console.log("Start building shouldFilter")
                // an `or` clause is converted to a `should` clause (at least one `should` clause must match)
                var orClauseKeys = Object.keys(searchOpts.range[rangeClauseKey])
                orClauseKeys.forEach(function (orClauseKey) {
                    var orClauseValue = searchOpts.range[rangeClauseKey][orClauseKey];
                    if (typeof orClauseValue === 'string') {
                        orClauseValue = orClauseValue.toLowerCase()
                    }

                    var orClauseValueKeys = Object.keys(orClauseValue)
                    //console.log("orClauseValueKeys", orClauseValueKeys)
                    if(orClauseValueKeys.length > 1){
                        //console.log("for OR break combined ranges out into two statements")
                        orClauseValueKeys.forEach(function (orClauseValueKey) {
                            var rangeFilter = {
                            range: { }
                            }
                            rangeFilter.range[orClauseKey] = {}
                            rangeFilter.range[orClauseKey][orClauseValueKey] = orClauseValue[orClauseValueKey]

                            shouldFilters.push(rangeFilter)
                        })
                    } else{

                        var rangeFilter = {
                            range: { }
                        }

                        rangeFilter.range[orClauseKey] = orClauseValue

                        shouldFilters.push(rangeFilter)
                    }
                })
            } else {
                //console.log("Start building mustFIlter")
                //console.log("rangeClauseValue",rangeClauseValue)
                if (Array.isArray(rangeClauseValue)) {
                    // where clause is an array, treat as an $in query

                } else if (typeof rangeClauseValue === 'object') {

                    var rangeFilter = {
                        range: { }
                    }

                    rangeFilter.range[rangeClauseKey] = rangeClauseValue
                    //console.log("rangeFilter", rangeFilter)

                    mustFilters.push(rangeFilter)
                } else {
                    // where clause is a primitive value - add a `term` query to filters

                    // if it's a string value, lowercase it since we index with `lowercase` filter
                    if (typeof rangeClauseValue === 'string') {
                        rangeClauseValue = rangeClauseValue.toLowerCase()
                    }

                    var rangeFilter = {
                        range: { }
                    }

                    rangeFilter.range[rangeClauseKey] = rangeClauseValue
                    //console.log("rangeFilter", rangeFilter)

                    mustFilters.push(rangeFilter)
                }
            }
        })

        //if a valid agg was entered add the filter to the query
        if(searchOpts.terms){
            //if a filter wasn't already created by the range searchOpt create it. 
            if(!body.query.filtered.filter){
                body.query.filtered.filter = {};
            }
            body.query.filtered.filter.and = mustFilters
        } else{
            //If no agg terms specified, add a normal filter (post filter)
            body.filter = {
                bool : {
                    must : [],
                    should : []
                }
            }

            if (mustFilters.length) {
                // generate `must` filters in bool query (if user supplied any)
                body.filter.bool.must = mustFilters
            }
            if (shouldFilters.length) {
                // generate `should` filters in bool query (if user supplied any)
                body.filter.bool.should = shouldFilters
            }
        }
    }

     console.log('\nmergeSearchBody body', util.inspect(body, true, 10, true))

    return body
}


/**
 * Make a search request using `reqOpts`, normalize results and call `cb`.
 *
 * @param  {Object}   reqOpts
 * @param  {Function} cb
 */
exports.doSearchAndNormalizeResults = function (searchUri, searchOpts, cb, requestType) {
    // merge `searchOpts` with default user-level search options
    searchOpts = exports.mergeSearchOptions(searchOpts)

    var body = exports.mergeSearchBody(searchOpts)
    

    var reqOpts = {
        method: 'POST',
        url: searchUri,
        body: JSON.stringify(body)
    }

    exports.backOffRequest(reqOpts, function (err, res, body) {
        if (err) {
            var error = new Error('Elasticsearch search error:'+util.inspect(err, true, 10, true))
            error.details = err

            return cb(error)
        }

        // console.log('\nsearch response body', util.inspect(body, true, 10, true))

        if (!body.hits) {
            var error = new Error('Unexpected Elasticsearch reply:'+util.inspect(body, true, 10, true))
            error.elasticsearchReply = body

            return cb(error)
        }

        if(requestType == 'aggregate'){
            var searchResults = {
                total: body.hits.total,
                aggregation: body.aggregations.my_agg
            }
        }
        else{
            var searchResults = {
                total: body.hits.total,
                hits: []
            }
        }

        if (body.hits.hits && body.hits.hits.length) {
            searchResults.hits = body.hits.hits
        }

        return cb(null, searchResults)
    })
}

/**
 * Make index name (with prefix) from `options`
 *
 * @param  {Object} options
 * @return {String}
 */
exports.makeIndexName = function (options) {
    return options.prefix ? (options.prefix + '-' + options.type) : options.type
}

/**
 * Form the elasticsearch URI for indexing/deleting a document
 *
 * @param  {Object} options
 * @param  {Mongoose document} doc
 * @return {String}
 */
exports.makeDocumentUri = function (options, doc) {
    var typeUri = exports.makeTypeUri(options)

    var docUri = typeUri+'/'+doc._id

    return docUri
}

/**
 * Form the elasticsearch URI up to the type of the document
 *
 * @param  {Object} options
 * @return {String}
 */
exports.makeTypeUri = function (options) {
    var indexUri = exports.makeIndexUri(options)

    var typeUri = indexUri + '/' + options.type

    return typeUri
}

/**
 * Form the elasticsearch URI up to the index of the document (index is same as type due to aliasing)
 * @param  {Object} options
 * @return {String}
 */
exports.makeIndexUri = function (options) {
    var domainUri = exports.makeDomainUri(options)

    var indexName = exports.makeIndexName(options)

    var indexUri = domainUri + '/' + indexName

    return indexUri
}

exports.makeDomainUri = function (options) {
    if(options.port){
        var domainUri = url.format({
            protocol: options.protocol,
            hostname: options.host,
            port: options.port
        })
    } else{
        var domainUri = url.format({
            protocol: options.protocol,
            hostname: options.host
        })
    }

    return domainUri
}

exports.makeAliasUri = function (options) {
    var domainUri = exports.makeDomainUri(options)

    var aliasUri = domainUri + '/_aliases'

    return aliasUri
}

exports.makeBulkIndexUri = function (indexName, options) {
    var domainUri = exports.makeDomainUri(options)

    var bulkIndexUri = domainUri + '/' + indexName + '/_bulk'

    return bulkIndexUri
}

// Checks that a response body from elasticsearch reported success
exports.elasticsearchBodyOk = function (elasticsearchBody) {
    // `ok` for elasticsearch version < 1, `acknowledged` for v1
    return elasticsearchBody && (elasticsearchBody.ok || elasticsearchBody.acknowledged || elasticsearchBody.total == elasticsearchBody.successful)
}